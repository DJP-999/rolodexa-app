import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111111",
        canvas: "#ffffff",
        surface: "#f6f6f7",
        hairline: "#e8e8ea",
        muted: "#8a8a8e",
        hot: "#ef4444",
        warm: "#f59e0b",
        good: "#22c55e",
        investor: "#7c3aed",
        dexa: "#3b82f6",
      },
      fontFamily: {
        sans: ["Inter", "Helvetica Neue", "Arial", "system-ui", "sans-serif"],
      },
      borderRadius: { xl2: "1rem" },
    },
  },
  plugins: [],
} satisfies Config;
