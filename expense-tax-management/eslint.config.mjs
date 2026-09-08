import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "frontend/**",
      "**/generated/**",
      "**/dist/**",
      "**/.next/**",
      "node_modules/**",
    ],
  },
  {
    files: [
      "services/**/*.ts",
      "packages/**/*.ts",
      "scripts/**/*.ts",
      "test/**/*.ts",
      "**/*.test.ts",
      "**/*.spec.ts",
    ],
    extends: [...tseslint.configs.recommended],
  },
);
