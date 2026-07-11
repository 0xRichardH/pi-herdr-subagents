---
name: release
description: Create a GitHub release with changelog. Use when asked to "release", "cut a release", "publish version", "bump version", "create release".
---

# Release

Create a versioned GitHub release with an auto-generated changelog from commits since the last release.

## Step 1: Determine Version

Check the current version and latest git tag:

```bash
cat package.json | grep '"version"'
git tag -l --sort=-v:refname | head -5
```

If the user provided a version, use it. Otherwise ask:

> What version? (current is X.Y.Z — patch/minor/major, or exact version)

Resolve semver:
- `patch` → X.Y.(Z+1)
- `minor` → X.(Y+1).0
- `major` → (X+1).0.0
- Exact version string → use as-is

## Step 2: Generate Changelog

Get commits since the last tag (or all commits if no tags exist):

```bash
# If tags exist:
git log $(git tag -l --sort=-v:refname | head -1)..HEAD --pretty=format:"- %s" --no-merges

# If no tags:
git log --pretty=format:"- %s" --no-merges
```

Group commits by type using conventional commit prefixes:

| Prefix | Section |
|--------|---------|
| `feat` | ✨ Features |
| `fix` | 🐛 Bug Fixes |
| `refactor` | ♻️ Refactoring |
| `docs` | 📝 Documentation |
| `chore`, `test`, `perf`, `ci` | 🔧 Other Changes |
| No prefix | 🔧 Other Changes |

Format as markdown. Omit empty sections. Strip the `type(scope):` prefix from each line for readability.

**Always start the changelog with this install block** (hardcoded):

````markdown
Install:

```bash
pi install git:github.com/0xRichardH/pi-herdr-subagents@v<VERSION>
```

Or latest:

```bash
pi install git:github.com/0xRichardH/pi-herdr-subagents
```
````

Then add the grouped commit sections below it.

Example output:

```markdown
## ✨ Features

- Add live subagent status widget
- Make subagent tool async — return immediately, steer on completion

## 🐛 Bug Fixes

- Fix session file collision with 3+ concurrent agents
- Truncate widget lines to terminal width
```

## Step 3: Update package.json

Bump the version in `package.json`:

```bash
# Read, update, write back — don't use npm version (it may auto-commit)
```

Use a precise edit to change only the version field.

## Step 4: Commit, Tag, Push

```bash
git add package.json
git commit -m "chore(release): v<VERSION>"
git tag v<VERSION>
git push && git push --tags
```

## Step 5: Create GitHub Release

```bash
gh release create v<VERSION> --title "v<VERSION>" --notes "<CHANGELOG>"
```

Pass the generated changelog as the `--notes` value. Use a temp file if the changelog is long:

```bash
echo "<CHANGELOG>" > /tmp/release-notes.md
gh release create v<VERSION> --title "v<VERSION>" --notes-file /tmp/release-notes.md
rm /tmp/release-notes.md
```

## Step 6: Verify

Confirm the release was created:

```bash
gh release view v<VERSION>
```

Print a summary:

```
✅ Released v<VERSION>
   Tag: v<VERSION>
   URL: https://github.com/<owner>/<repo>/releases/tag/v<VERSION>
```
