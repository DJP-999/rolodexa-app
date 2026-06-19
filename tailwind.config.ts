import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111111",
        canvas: "#f7f7f8",
        surface: "#f1f1f3",
        hairline: "#e8e8ea",
        muted: "#8a8a8e",
        hot: "#ef4444",
        warm: "#f59e0b",
        good: "#22c55e",
        investor: "#7c3aed",
        dexa: "#3b82f6",
      },
      fontFamily: {
        // Match the original exactly.
        sans: [
          "Helvetica Now Display",
          "Helvetica Neue",
          "Helvetica",
          "Arial",
          "system-ui",
          "sans-serif",
        ],
      },
      borderRadius: { panel: "28px" },
    },
  },
  plugins: [],
} satisfies Config;
