import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { ProtectedRoute } from "@/components/layout/protected-route";

// Pages
import Login from "@/pages/login";
import Overview from "@/pages/overview";
import Runs from "@/pages/runs";
import RunDetail from "@/pages/run-detail";
import Products from "@/pages/products";
import ProductDebug from "@/pages/product-debug";
import Google from "@/pages/google";
import Meta from "@/pages/meta";
import Images from "@/pages/images";
import Inventory from "@/pages/inventory";
import DataQuality from "@/pages/data-quality";
import Feeds from "@/pages/feeds";
import Rules from "@/pages/rules";

const queryClient = new QueryClient();

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Login} />
        
        {/* Protected Dashboard Routes */}
        <Route path="/overview">
          <ProtectedRoute><DashboardLayout><Overview /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/runs">
          <ProtectedRoute><DashboardLayout><Runs /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/runs/:id">
          <ProtectedRoute><DashboardLayout><RunDetail /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/products">
          <ProtectedRoute><DashboardLayout><Products /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/products/:id">
          <ProtectedRoute><DashboardLayout><ProductDebug /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/google">
          <ProtectedRoute><DashboardLayout><Google /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/meta">
          <ProtectedRoute><DashboardLayout><Meta /></DashboardLayout></ProtectedRoute>
        </Route>
        {/* Retained for direct links; not shown in operational navigation. */}
        <Route path="/images">
          <ProtectedRoute><DashboardLayout><Images /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/inventory">
          <ProtectedRoute><DashboardLayout><Inventory /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/data-quality">
          <ProtectedRoute><DashboardLayout><DataQuality /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/feeds">
          <ProtectedRoute><DashboardLayout><Feeds /></DashboardLayout></ProtectedRoute>
        </Route>
        <Route path="/rules">
          <ProtectedRoute><DashboardLayout><Rules /></DashboardLayout></ProtectedRoute>
        </Route>
        
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
