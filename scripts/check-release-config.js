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
 * Reads GITHUB_TOKEN from the environment when present.
 *
 * On credentials: `administration` is not a workflow permission -- the GITHUB_TOKEN cannot be
 * granted it -- so the branchProtection and workflowPermissions checks below need a
 * fine-grained PAT or App token supplied as a secret. This repository's policy therefore omits
 * them and verifies those two settings by hand; the checks remain here for repositories that
 * decide a stored admin-scoped credential is an acceptable trade.
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
    'could not read this setting with the supplied credential. `administration` is not a ' +
    'workflow permission, so this needs a fine-grained PAT or App token; refusing to treat ' +
    'an unverifiable setting as correct';

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Fetches every tag ruleset once. The list endpoint omits conditions, rules and bypass
 * actors, so each has to be read individually.
 */
async function loadTagRulesets() {
    const list = await gh(`/repos/${repo}/rulesets`);
    if (list.state !== 'ok') return list;

    const details = [];
    for (const summary of list.body.filter((r) => r.target === 'tag')) {
        const detail = await gh(`/repos/${repo}/rulesets/${summary.id}`);
        if (detail.state === 'ok') details.push(detail.body);
    }
    return { state: 'ok', body: details };
}

/**
 * Each entry describes one ruleset by the rules it must carry, not by name -- names are
 * editable and carry no meaning to GitHub.
 *
 * Creation and protection have to be separate rulesets, because bypass actors are scoped to
 * a ruleset rather than to a rule. "Restrict creations" means *only* bypass actors may create
 * matching tags, so maintainers need a bypass to push a release tag at all -- and granting it
 * on a ruleset that also restricts updates and deletions would exempt them from those too,
 * making the tags mutable by exactly the people most able to misuse that.
 *
 * If both entries end up matching a single combined ruleset, the protection entry's
 * no-bypass assertion fails. That is the correct answer: a combined ruleset either cannot
 * create tags or cannot protect them.
 */
async function checkTagRulesets(expectedList, all) {
    for (const expected of expectedList) {
        const label = `tag ruleset (${expected.rules.join('+')})`;

        const match = all.find((r) => {
            const include = r.conditions?.ref_name?.include ?? [];
            const present = new Set((r.rules ?? []).map((x) => x.type));
            return (
                include.includes(expected.pattern) && expected.rules.every((x) => present.has(x))
            );
        });

        if (!match) {
            fail(
                label,
                `no tag ruleset over "${expected.pattern}" carries ${expected.rules.join(', ')}`
            );
            continue;
        }

        if (match.enforcement !== 'active') {
            fail(label, `"${match.name}" enforcement is "${match.enforcement}", expected "active"`);
        }

        // Exclusions win over includes, so an excluded pattern silently unprotects the tags
        // this ruleset appears to cover. This policy admits no exceptions, so require none.
        const exclude = match.conditions?.ref_name?.exclude ?? [];
        if (exclude.length > 0) {
            fail(label, `"${match.name}" excludes ${exclude.join(', ')}, expected no exclusions`);
        }

        // A bypass actor silently exempts someone from every rule in the ruleset, which is the
        // most valuable thing to notice and the least visible in the UI. Three states rather
        // than a boolean, because the API omits the field entirely for callers without
        // repository write access, and a missing field must never read as an empty one:
        //
        //   allowed    expected to have them (the creation ruleset); not inspected
        //   forbidden  must be visible AND empty; invisible is a failure, not a pass
        //   unchecked  a deliberate, recorded decision not to verify it here
        //
        // "unchecked" exists so that skipping this is a visible choice in a code-owner-gated
        // file, reviewable in a diff, rather than something the script quietly does.
        if (expected.bypassActors === 'forbidden') {
            if (!Array.isArray(match.bypass_actors)) {
                fail(
                    label,
                    `"${match.name}" bypass actors are not visible to this caller, so "none" ` +
                        'cannot be confirmed. Use a credential with repository write access, or ' +
                        'record the decision not to check by setting bypassActors to "unchecked"'
                );
            } else if (match.bypass_actors.length > 0) {
                const who = match.bypass_actors.map((a) => a.actor_type ?? 'actor').join(', ');
                fail(
                    label,
                    `"${match.name}" has ${match.bypass_actors.length} bypass actor(s) (${who}), expected none`
                );
            }
        }

        if (!problems.some((p) => p.startsWith(label))) {
            const notes = {
                allowed: 'bypass expected',
                forbidden: 'no bypass actors',
                unchecked: 'bypass actors NOT CHECKED',
            };
            pass(
                `${label}: "${match.name}" active, no exclusions, ${notes[expected.bypassActors] ?? 'bypass unspecified'}`
            );
        }
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

    // Non-null is not enough: "Protected branches only" is also non-null, and in that mode
    // any protected branch can deploy regardless of the saved custom list. Only
    // custom_branch_policies makes the list below the effective restriction.
    const { protected_branches: protectedOnly, custom_branch_policies: custom } =
        env.deployment_branch_policy;
    if (protectedOnly !== false || custom !== true) {
        return fail(
            label,
            'deployment branches are set to "Protected branches only"; any protected branch ' +
                'can deploy. Expected "Selected branches and tags"'
        );
    }

    const res = await gh(
        `/repos/${repo}/environments/${encodeURIComponent(expected.name)}/deployment-branch-policies`
    );
    if (res.state === 'forbidden') return fail(label, NEEDS_SCOPE);
    if (res.state === 'absent') return fail(label, 'has no deployment branch policies');

    // Compare the type too. A *tag* policy named "main" would otherwise satisfy a required
    // branch named "main", while actually blocking deployment from the main branch.
    const actual = (res.body.branch_policies ?? []).map((p) => `${p.type}:${p.name}`).sort();
    const want = expected.deploymentBranches.map((name) => `branch:${name}`).sort();

    // Exact match, not a superset: an extra allowed branch is precisely the drift to catch.
    if (actual.length !== want.length || actual.some((entry, i) => entry !== want[i])) {
        fail(
            label,
            `deployment policies are [${actual.join(', ')}], expected exactly [${want.join(', ')}]`
        );
    } else {
        pass(`${label}: deployment branches exactly [${expected.deploymentBranches.join(', ')}]`);
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

    if (policy.tagRulesets) {
        const all = await loadTagRulesets();
        if (all.state === 'forbidden') fail('tag rulesets', NEEDS_SCOPE);
        else if (all.state === 'absent') fail('tag rulesets', 'the repository has no rulesets');
        else await checkTagRulesets(policy.tagRulesets, all.body);
    }
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
