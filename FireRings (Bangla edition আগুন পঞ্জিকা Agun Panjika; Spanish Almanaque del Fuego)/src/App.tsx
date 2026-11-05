import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "./components/Shell";
import { AppProvider } from "./state/app";
import { SettingsProvider } from "./state/settings";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, networkMode: "always" } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <AppProvider>
          <Shell />
        </AppProvider>
      </SettingsProvider>
    </QueryClientProvider>
  );
}

