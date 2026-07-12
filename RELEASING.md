# Release guide

GitHub Actions publishes this package to npm when you push a tag named `vX.Y.Z`. The tag version must match the version in `package.json`.

## Prerequisites

You need:

- Publish access to the `pi-herdr-subagents` package on npm
- Permission to manage this repository's GitHub Actions secrets
- A clean local `main` branch

Run the checks before starting:

```bash
npm ci
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

If the package does not exist on npm yet and the workflow cannot create it with the token, publish the first version locally with `npm login` and `npm publish --access public`. Keep the tag-driven workflow for later releases.

## Publish a release

Choose the semantic version increment:

- `patch`: compatible bug fixes, such as `0.1.0` to `0.1.1`
- `minor`: compatible features, such as `0.1.0` to `0.2.0`
- `major`: breaking changes, such as `0.1.0` to `1.0.0`

Create the version commit and tag:

```bash
npm version patch --sign-git-tag-version
```

Replace `patch` with `minor` or `major` when appropriate. If you do not sign Git tags, use:

```bash
npm version patch --no-git-tag-version
```

In that case, create the tag separately after committing the version change:

```bash
git add package.json package-lock.json
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
```

Push the release commit and tag:

```bash
git push origin main --follow-tags
```

Watch the **Publish to npm** workflow on the repository's **Actions** page. The workflow installs dependencies, runs tests, checks the tag against `package.json`, previews the package contents, and publishes to npm with provenance.

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

### Tag and package versions differ

The workflow stops when, for example, tag `v0.1.1` points to a commit whose `package.json` still contains `0.1.0`. Create a new matching version and tag. Do not reuse a published npm version.

### npm rejects authentication

Confirm that the GitHub secret is named exactly `NPM_TOKEN`, the token has write access, and it has not expired or been revoked.

### npm reports that the version already exists

npm versions are immutable. Increment the package version, create a new tag, and run the release again.

### The package is absent from pi.dev

Confirm that npm published the package publicly and that `package.json` contains the `pi-package` keyword. Gallery indexing may take some time.
