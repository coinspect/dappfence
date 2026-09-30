## Summary

<!-- One or two sentences. What changes, and why. -->

## Type of change

<!-- Mark with x -->

-   [ ] Bug fix
-   [ ] New feature
-   [ ] Refactor / cleanup (no behavior change)
-   [ ] Documentation
-   [ ] Dependency upgrade
-   [ ] Release infrastructure (workflows, scripts, keys)
-   [ ] Security fix — **also file a private advisory before merging**

## Testing

<!-- What you ran locally + relevant commands. -->

-   [ ] `npm test` passes
-   [ ] `npm run check` passes
-   [ ] Manual verification: <!-- describe -->

## Release-path impact

<!-- Answer each. If yes to any, request review from @coinspect/dappfence-admins. -->

-   [ ] Touches `.github/workflows/{release,monitor}.yml`?
-   [ ] Touches `scripts/{sync-versions,deprecate,check-lock-integrity}.js` or `scripts/monitor/`?
-   [ ] Touches `.github/release-keys/`?
-   [ ] Touches `package-lock.json`?
-   [ ] Adds a new publishable package? (must set `files`, `publishConfig.access`, `prepublishOnly`
        if a build is needed — see
        [release-setup.md](../docs/release-setup.md#adding-a-new-package-to-the-repo))

## Documentation

-   [ ] Updated docs affected by this change
-   [ ] Not applicable
