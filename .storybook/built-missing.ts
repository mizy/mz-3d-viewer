/**
 * Stand-in for dist-lib/index.js when the package has not been built. The built-package story
 * checks for `createModelViewer` and asks for `pnpm build:pkg` instead of failing to load.
 */
export const storybookBuiltPackageMissing = true;
