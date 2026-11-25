import { configureCadAssets } from "../src/cadAssets";

// Same directory as the app's public/wasm/occt, exposed by Storybook's staticDirs. The package's
// own assets live at /dist-lib/occt/ and are configured by the built-package story itself.
configureCadAssets({ baseUrl: "/occt/" });

const preview = {
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
    backgrounds: {
      default: "viewer",
      values: [{ name: "viewer", value: "#090d12" }]
    }
  }
};

export default preview;
