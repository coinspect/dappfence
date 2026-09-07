## Fixtures

Raw byte slices captured from Next.js 15.5.18 compiled runtime files:

-   `app-page.runtime.prod.excerpt.txt` — 3000-byte slice from
    `next/dist/compiled/next-server/app-page.runtime.prod.js` starting at offset 427800. Contains
    all three RSC-emission template literals (mangled variable names).
-   `app-page.runtime.dev.excerpt.txt` — 3500-byte slice from the dev bundle starting at
    offset 1118600. Same templates with unmangled identifiers.

Extensions are `.txt` so linters/formatters/type-checkers do not touch them. Read as bytes via
`fs.readFile`.
