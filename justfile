_default:
	just --list

build:
	pnpm build

# publishes the package.json version as a GitHub release tarball; a no-op if already published
release:
	scripts/release
