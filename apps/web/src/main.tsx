import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SloncordRoot from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Missing #root');

const tree = import.meta.env.PROD ? (
  <SloncordRoot />
) : (
  <StrictMode>
    <SloncordRoot />
  </StrictMode>
);

createRoot(rootEl).render(tree);
