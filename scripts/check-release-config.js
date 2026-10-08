#!/usr/bin/env node
/**
 * Asserts that a repository's GitHub settings still match the release policy.
 *
 * The release pipeline's guarantees live outside the repository — in a tag ruleset, an
 * environment's reviewers and deployment-branch restriction, branch protection, and whether
 * the CODEOWNERS owners actually resolve. Documentation cannot notice when one of those is
 * weakened later, so this runs in release.yml's `verify` job and fails the release instead.
 *
 * Deliberately repo-agnostic: everything project-specific lives in the policy file, so this
 * script can be copied to another repository, or extracted into a shared one, unchanged.
 * It also has no dependencies — `verify` runs no `npm ci`, so there are no node_modules.
 *
 * A check the policy does not mention is not run. A check it does mention but which cannot be
 * performed — no token, insufficient scope — is a FAILURE, not a skip: "could not verify" must
 * never read as "fine".
 *
 * Usage:
 *   node scripts/check-release-config.js                            audit $GITHUB_REPOSITORY
 *   node scripts/check-release-config.js --repo <owner>/<name>      audit a specific repository
 *   node scripts/check-release-config.js --policy <path>            use a different policy file
 *
 * Reads GITHUB_TOKEN from the environment when present. Branch protection and workflow
 * permissions require it (with `administration: read`); the rest are readable without one on a
 * public repository.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// GITHUB_API_URL is set by Actions itself, so this works unchanged on GitHub Enterprise
// Server — and lets the checks be exercised against a stub during development.
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);

function argValue(name) {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
}

const policyPath = resolve(ROOT, argValue('--policy') ?? '.github/release-policy.json');
const repo = argValue('--repo') ?? process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error('check-release-config: no repository to audit.');
    console.error('\nFix: pass --repo <owner>/<name>, or set GITHUB_REPOSITORY.');
    process.exit(1);
}

let policy;
try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
} catch (err) {
    console.error(`check-release-config: could not read policy file ${policyPath}`);
    console.error(`  ${err.message}`);
    process.exit(1);
}

const problems = [];
const checked = [];

function fail(check, message) {
    problems.push(`${check}: ${message}`);
}

function pass(message) {
    checked.push(message);
}

/**
 * Explicit status triage rather than res.ok, matching scripts/sync-versions.js. Returns a
 * discriminated result so callers can tell "absent" (404) from "not allowed to look"
 * (401/403) — those mean very different things, and only one of them is about the setting.
 */
async function gh(path) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API}${path}`, { headers });
    if (res.status === 200) return { state: 'ok', body: await res.json() };
    if (res.status === 404) return { state: 'absent' };
    if (res.status === 401 || res.status === 403) return { state: 'forbidden', status: res.status };
    throw new Error(`GitHub API GET ${path} failed — HTTP ${res.status}`);
}

const NEEDS_SCOPE =
    'could not read this setting. A GITHUB_TOKEN with `administration: read` is required; ' +
    'refusing to treat an unverifiable setting as correct';

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkTagRuleset(expected) {
    const label = 'tag ruleset';
    const list = await gh(`/repos/${repo}/rulesets`);
    if (list.state === 'forbidden') return fail(label, NEEDS_SCOPE);
    if (list.state === 'absent') return fail(label, 'the repository has no rulesets');

    // The list endpoint omits conditions and rules, so each tag ruleset has to be fetched.
    const tagRulesets = list.body.filter((r) => r.target === 'tag');
    let match;
    for (const summary of tagRulesets) {
        const detail = await gh(`/repos/${repo}/rulesets/${summary.id}`);
        if (detail.state !== 'ok') continue;
        const include = detail.body.conditions?.ref_name?.include ?? [];
        if (include.includes(expected.pattern)) {
            match = detail.body;
            break;
        }
    }

    if (!match) {
        return fail(label, `no tag ruleset targets "${expected.pattern}"`);
    }
    if (match.enforcement !== 'active') {
        fail(label, `"${match.name}" enforcement is "${match.enforcement}", expected "active"`);
    }

    const present = new Set((match.rules ?? []).map((r) => r.type));
    const missing = expected.rules.filter((r) => !present.has(r));
    if (missing.length > 0) {
        fail(label, `"${match.name}" is missing rule(s): ${missing.join(', ')}`);
    }

    // A bypass actor silently exempts someone from every rule above, which is the most
    // valuable thing to notice and the least visible in the UI.
    const bypass = match.bypass_actors ?? [];
    if (!expected.allowBypassActors && bypass.length > 0) {
        fail(label, `"${match.name}" has ${bypass.length} bypass actor(s), expected none`);
    }

    if (problems.length === 0 || !problems.some((p) => p.startsWith(label))) {
        pass(
            `${label}: "${match.name}" active over ${expected.pattern}, ${present.size} rules, no bypass`
        );
    }
}

async function checkEnvironment(expected) {
    const label = `environment ${expected.name}`;
    const env = await gh(`/repos/${repo}/environments/${encodeURIComponent(expected.name)}`);
    if (env.state === 'forbidden') return fail(label, NEEDS_SCOPE);
    if (env.state === 'absent') {
        return fail(
            label,
            'does not exist. Note GitHub creates a referenced environment on first use with ' +
                'no protection rules at all, so a release would publish unreviewed'
        );
    }

    const rules = env.body.protection_rules ?? [];
    const reviewers = rules.find((r) => r.type === 'required_reviewers');

    if (expected.requireReviewers && !reviewers) {
        fail(label, 'has no required reviewers — releases would publish without approval');
    }
    if (reviewers) {
        if (expected.preventSelfReview && reviewers.prevent_self_review !== true) {
            fail(label, 'has "Prevent self-review" disabled — a releaser could approve themselves');
        }
        if ((reviewers.reviewers ?? []).length === 0) {
            fail(label, 'required-reviewers rule lists nobody');
        }
    }

    if (Array.isArray(expected.deploymentBranches)) {
        await checkDeploymentBranches(expected, label, env.body);
    }

    if (!problems.some((p) => p.startsWith(label))) {
        const who = (reviewers?.reviewers ?? [])
            .map((r) => r.reviewer?.slug ?? r.reviewer?.login ?? r.type)
            .join(', ');
        pass(`${label}: reviewers (${who}), prevent-self-review on`);
    }
}

async function checkDeploymentBranches(expected, label, env) {
    // deployment_branch_policy === null is the "No restriction" setting. Without it, a
    // doctored workflow on any branch can reach this environment and mint the publish
    // credential, since npm's trusted publishing does not match on branch.
    if (!env.deployment_branch_policy) {
        return fail(label, 'deployment branches are unrestricted ("No restriction")');
    }

    const res = await gh(
        `/repos/${repo}/environments/${encodeURIComponent(expected.name)}/deployment-branch-policies`
    );
    if (res.state === 'forbidden') return fail(label, NEEDS_SCOPE);
    if (res.state === 'absent') return fail(label, 'has no deployment branch policies');

    const actual = (res.body.branch_policies ?? []).map((p) => p.name).sort();
    const want = [...expected.deploymentBranches].sort();

    // Exact match, not a superset: an extra allowed branch is precisely the drift to catch.
    if (actual.length !== want.length || actual.some((name, i) => name !== want[i])) {
        fail(
            label,
            `deployment branches are [${actual.join(', ')}], expected exactly [${want.join(', ')}]`
        );
    } else {
        pass(`${label}: deployment branches exactly [${want.join(', ')}]`);
    }
}

async function checkCodeowners() {
    const label = 'CODEOWNERS';
    const res = await gh(`/repos/${repo}/codeowners/errors`);
    if (res.state === 'forbidden') return fail(label, NEEDS_SCOPE);
    if (res.state === 'absent') return fail(label, 'no CODEOWNERS file found');

    const errors = res.body.errors ?? [];
    if (errors.length > 0) {
        fail(label, `${errors.length} error(s) — owners may not exist or lack write access:`);
        for (const e of errors.slice(0, 5)) {
            problems.push(`    line ${e.line}: ${e.message ?? e.kind}`);
        }
    } else {
        pass('CODEOWNERS: no errors — every owner resolves and has repository access');
    }
}

async function checkBranchProtection(expected) {
    const label = `branch protection (${expected.branch})`;
    const res = await gh(
        `/repos/${repo}/branches/${encodeURIComponent(expected.branch)}/protection`
    );
    if (res.state === 'forbidden') return fail(label, NEEDS_SCOPE);
    if (res.state === 'absent') {
        return fail(label, 'the branch is not protected — CODEOWNERS enforces nothing');
    }

    const reviews = res.body.required_pull_request_reviews;
    if (!reviews) {
        return fail(label, 'does not require a pull request before merging');
    }
    if (expected.requireCodeOwnerReviews && reviews.require_code_owner_reviews !== true) {
        return fail(
            label,
            '"Require review from Code Owners" is off, so CODEOWNERS only suggests reviewers'
        );
    }
    pass(`${label}: pull request required, code-owner review required`);
}

async function checkWorkflowPermissions(expected) {
    const label = 'workflow permissions';
    const res = await gh(`/repos/${repo}/actions/permissions/workflow`);
    if (res.state === 'forbidden') return fail(label, NEEDS_SCOPE);
    if (res.state === 'absent') return fail(label, 'could not read Actions workflow permissions');

    const actual = res.body.default_workflow_permissions;
    if (expected.defaultPermissions && actual !== expected.defaultPermissions) {
        fail(
            label,
            `default GITHUB_TOKEN permissions are "${actual}", expected "${expected.defaultPermissions}"`
        );
    }
    const canApprove = res.body.can_approve_pull_request_reviews;
    if (expected.canApprovePullRequests === false && canApprove !== false) {
        fail(label, 'Actions is allowed to create and approve pull requests');
    }
    if (!problems.some((p) => p.startsWith(label))) {
        pass(`${label}: default "${actual}", cannot approve pull requests`);
    }
}

// ---------------------------------------------------------------------------

async function main() {
    console.log(`Auditing ${repo} against ${policyPath.replace(ROOT + '/', '')}\n`);

    if (policy.tagRuleset) await checkTagRuleset(policy.tagRuleset);
    if (policy.environment) await checkEnvironment(policy.environment);
    if (policy.codeowners?.requireNoErrors) await checkCodeowners();
    if (policy.branchProtection) await checkBranchProtection(policy.branchProtection);
    if (policy.workflowPermissions) await checkWorkflowPermissions(policy.workflowPermissions);

    for (const line of checked) {
        console.log(`  ✓ ${line}`);
    }

    if (problems.length === 0) {
        console.log(`\n✓ ${checked.length} release settings match the policy.`);
        process.exit(0);
    }

    console.error(`\n✗ ${problems.length} release setting(s) do not match the policy:\n`);
    for (const msg of problems) {
        console.error(`  ${msg}`);
    }
    console.error(
        '\nFix: reconcile the repository settings with .github/release-policy.json, or change ' +
            'the policy\nif the new configuration is intended. See docs/release-setup.md.'
    );
    process.exit(1);
}

await main();
