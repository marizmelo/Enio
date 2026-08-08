// globals.css is deliberately NOT imported here. Tailwind v4 compiles it in a
// separate step (see build.mjs) because esbuild cannot resolve
// `@import "tailwindcss"`; index.html links the compiled file directly.
import { createRoot } from "react-dom/client";
import { App } from "@/App";

createRoot(document.getElementById("root")).render(<App />);
