import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    "load-test": {
      // シナリオは k6 バイナリが直接読み込む（TS/JSから import されない）ため entry として明示する。
      // k6/http 等は k6 ランタイム組み込みモジュールで npm パッケージではないため ignoreDependencies に含める。
      entry: ["scenarios/**/*.js", "sst.config.ts"],
      ignoreBinaries: ["k6"],
      ignoreDependencies: ["sst", "k6"],
    },
    infra: {
      entry: ["src/**/*.ts"],
    },
  },
};

export default config;
