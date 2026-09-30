/**
 * Alerter interface. Takes a list of Observations, decides what to dispatch.
 * Default is stdout-only — safe to run anywhere. GitHub Issues alerter fires
 * only when the workflow provides GITHUB_TOKEN and GITHUB_REPOSITORY, so local
 * runs stay chatter-free.
 */

import { SEVERITY } from './observation.js';

export function stdoutAlerter(observations) {
    for (const obs of observations) {
        const lines = [
            `[${obs.severity.toUpperCase()}] ${obs.monitor}: ${obs.title}`,
            `  subject: ${obs.subject}`,
            `  time:    ${obs.timestamp}`,
        ];
        if (Object.keys(obs.details).length > 0) {
            lines.push(`  details: ${JSON.stringify(obs.details)}`);
        }
        for (const a of obs.annotations) {
            lines.push(`  · ${a.source}${a.model ? ` (${a.model})` : ''}: ${a.note}`);
        }
        const stream = obs.severity === SEVERITY.INFO ? console.log : console.error;
        stream(lines.join('\n'));
    }
}

/**
 * Files a GitHub issue for each ALARM. WARN is aggregated into one weekly digest
 * issue (updated in place). INFO is stdout only.
 * Requires: GITHUB_TOKEN + GITHUB_REPOSITORY in the environment.
 */
export async function githubIssueAlerter(observations) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!token || !repo) {
        console.error('githubIssueAlerter: GITHUB_TOKEN or GITHUB_REPOSITORY missing — skipping');
        return;
    }
    const alarms = observations.filter((o) => o.severity === SEVERITY.ALARM);
    for (const obs of alarms) {
        await createIssue(token, repo, obs);
    }
}

async function createIssue(token, repo, obs) {
    const body = [
        `**Monitor:** \`${obs.monitor}\``,
        `**Subject:** \`${obs.subject}\``,
        `**Time:** ${obs.timestamp}`,
        `**Severity:** ${obs.severity}`,
        '',
        '### Details',
        '```json',
        JSON.stringify(obs.details, null, 2),
        '```',
    ];
    if (obs.annotations.length > 0) {
        body.push('', '### Annotations');
        for (const a of obs.annotations) {
            body.push(`- **${a.source}**${a.model ? ` _(${a.model})_` : ''}: ${a.note}`);
        }
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
            title: `[monitor:${obs.monitor}] ${obs.title}`,
            body: body.join('\n'),
            labels: ['security', 'monitor-alert', `severity:${obs.severity}`],
        }),
    });
    if (!res.ok) {
        console.error(`failed to file issue for ${obs.id}: HTTP ${res.status}`);
    }
}
