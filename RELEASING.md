# Release guide

GitHub Actions publishes this package when the version in `package.json` changes on `main`. The release workflow validates the package, creates a matching `vX.Y.Z` tag, publishes to npm with provenance, and creates a GitHub Release with generated notes and a link to the npm package.

The published version must be unique on npm.

## Prerequisites

You need:

- Publish access to the `pi-herdr-subagents` package on npm
- Permission to manage this repository's GitHub Actions secrets
- A clean local `main` branch

Run the checks before starting:

```bash
npm ci
npm run lint
npm test
npm pack --dry-run
```

## Configure npm authentication

1. Sign in to [npm](https://www.npmjs.com/).
2. Open [Access Tokens](https://www.npmjs.com/settings/~/tokens).
3. Create a granular access token with read and write package access.
4. Allow automated publishing through 2FA if npm presents that option.
5. Copy the token. npm only displays it once.
6. Open the GitHub repository's **Settings → Secrets and variables → Actions**.
7. Create a repository secret named `NPM_TOKEN` and paste the token as its value.

Never store the token in the repository, `package.json`, or a committed `.npmrc` file.

If the package does not exist on npm yet and the workflow cannot create it with the token, publish the first version locally with `npm login` and `npm publish --access public`. Keep the version-driven workflow for later releases.

## Publish a release

Choose the semantic version increment:

- `patch`: compatible bug fixes, such as `0.1.0` to `0.1.1`
- `minor`: compatible features, such as `0.1.0` to `0.2.0`
- `major`: breaking changes, such as `0.1.0` to `1.0.0`

Create the version commit without a local tag:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v$(node -p \"require('./package.json').version\")"
git push origin main
```

Replace `patch` with `minor` or `major` when appropriate. The push triggers the **Release** workflow, which installs dependencies, runs lint and tests, previews package contents, creates and pushes the version tag, publishes to npm with provenance, and creates the GitHub Release.

You can rerun a failed or incomplete release from **Actions → Release → Run workflow**. The workflow safely skips an npm version, tag, or GitHub Release that already exists, while verifying that an existing tag points to the release commit.

## Verify the release

After the workflow succeeds, inspect the published package:

```bash
npm view pi-herdr-subagents
```

Test installation through Pi:

```bash
pi install npm:pi-herdr-subagents
```

The package should appear at <https://pi.dev/packages/pi-herdr-subagents> after the gallery indexes the npm release.

## Troubleshooting

### Tag points to another commit

The workflow stops if the matching version tag already points to a different commit. Do not move or reuse release tags. Increment the package version and push a new release commit instead.

### npm rejects authentication

Confirm that the GitHub secret is named exactly `NPM_TOKEN`, the token has write access, and it has not expired or been revoked.

### npm reports that the version already exists

npm versions are immutable. Increment the package version and push a new release commit.

### The package is absent from pi.dev

Confirm that npm published the package publicly and that `package.json` contains the `pi-package` keyword. Gallery indexing may take some time.
