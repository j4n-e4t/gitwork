import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NuqsAdapter } from "nuqs/adapters/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NuqsAdapter>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </NuqsAdapter>
  </StrictMode>,
);
