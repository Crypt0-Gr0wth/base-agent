import { useEffect, useRef } from "react";
import { Route, Switch as RouterSwitch, Redirect, useRoute } from "wouter";
import { TopBar } from "./components/TopBar";
import { PortfolioView } from "./components/PortfolioView";
import { ChatProvider } from "./components/ChatContext";
import { FloatingChat } from "./components/FloatingChat";
import { TabBar } from "./components/TabBar";
import { Footer } from "./components/Footer";
import { TabsProvider, useTabs } from "./components/TabsContext";
import { ProtocolTabView } from "./components/ProtocolTabView";
import { ConfigureView } from "./components/ConfigureView";
import { ActionInboxView } from "./components/ActionInboxView";
import { TokenExplorerView } from "./components/TokenExplorerView";
import { PerpsView } from "./components/PerpsView";
import { BunnyExchangeView } from "./components/BunnyExchangeView";
import { BunnyDsView } from "./components/BunnyDsView";
import Landing from "./pages/Landing";
import Litepaper from "./pages/Litepaper";
import { useAuth } from "./hooks/useAuth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

const queryClient = new QueryClient();

function HomeView() {
  return (
    <div className="flex-1 w-full min-h-0 flex flex-col">
      <PortfolioView />
    </div>
  );
}

function TabContent() {
  const { tabs, activeId } = useTabs();
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  if (!active) return <HomeView />;
  if (active.kind === "settings") return <ConfigureView />;
  if (active.kind === "actions-inbox") return <ActionInboxView />;
  if (active.kind === "tokens") return <TokenExplorerView />;
  if (active.kind === "perps") return <PerpsView />;
  if (active.kind === "bunny") return <BunnyExchangeView />;
  if (active.kind === "bunnyds") return <BunnyDsView />;
  if (active.kind === "protocol" && active.payload) {
    return <ProtocolTabView protocolId={active.payload.protocolId} />;
  }
  return <HomeView />;
}

// When the terminal is opened via a shareable report link
// (/terminal/report/<address>), switch to the tokens tab once so the report
// panel renders for that token. The tab content itself reads the address from
// the route to focus the right token.
function useReportDeepLink(): void {
  const [match] = useRoute("/terminal/report/:address");
  const { setActive } = useTabs();
  const doneRef = useRef(false);
  useEffect(() => {
    if (match && !doneRef.current) {
      doneRef.current = true;
      setActive("tokens");
    }
  }, [match, setActive]);
}

function TerminalShell() {
  useReportDeepLink();
  return (
    <div className="h-full w-full flex flex-col bg-background text-foreground overflow-hidden">
      <TopBar />
      <TabBar />
      <div className="flex-1 min-h-0 flex w-full">
        <TabContent />
      </div>
      <Footer />
      <FloatingChat />
    </div>
  );
}

function TerminalApp() {
  const auth = useAuth();
  if (auth.loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-background text-muted-foreground font-mono text-sm">
        loading…
      </div>
    );
  }
  if (!auth.authenticated) {
    return <Redirect to="/" />;
  }
  return (
    <TabsProvider>
      <ChatProvider>
        <TerminalShell />
      </ChatProvider>
    </TabsProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterSwitch>
          <Route path="/" component={Landing} />
          <Route path="/litepaper" component={Litepaper} />
          <Route path="/terminal" component={TerminalApp} />
          <Route path="/terminal/:rest*" component={TerminalApp} />
          <Route>
            <Redirect to="/" />
          </Route>
        </RouterSwitch>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
