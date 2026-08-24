import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import PasswordGate from "./components/PasswordGate";
import Index from "./pages/Index";
import Uptime from "./pages/Uptime";
import Diagnostics from "./pages/Diagnostics";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Pantalla pública de uptime (sin contraseña) */}
          <Route path="/uptime" element={<Uptime />} />
          <Route path="/" element={<PasswordGate><Index /></PasswordGate>} />
          <Route path="/diagnostico" element={<PasswordGate><Diagnostics /></PasswordGate>} />
          <Route path="/diagnostics" element={<PasswordGate><Diagnostics /></PasswordGate>} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<PasswordGate><NotFound /></PasswordGate>} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
