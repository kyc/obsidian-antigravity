import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    { ignores: ["main.js", "*.mjs", "jest.config.js", "tests/**"] },
    ...obsidianmd.configs.recommendedWithLocalesEn,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "obsidianmd/ui/sentence-case": ["warn", {
                brands: ["Obsidian", "Antigravity", "Gemini", "GitHub", "Claude", "Sonnet", "GPT"],
                acronyms: ["API", "URL", "HTML", "MOC", "CLI", "IDE", "YAML", "NDJSON", "HTTP", "TCP", "ID"],
                enforceCamelCaseLower: true,
            }],
            "obsidianmd/ui/sentence-case-locale-module": ["warn", {
                brands: ["Obsidian", "Antigravity", "Gemini", "GitHub", "Claude", "Sonnet", "GPT"],
                acronyms: ["API", "URL", "HTML", "MOC", "CLI", "IDE", "YAML", "NDJSON", "HTTP", "TCP", "ID"],
            }],
        },
    },
]);
