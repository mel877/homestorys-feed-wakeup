import React, { ReactNode } from "react";
import { useLocation } from "wouter";
import { getGetDashboardAuthMeQueryKey, useGetDashboardAuthMe } from "@workspace/api-client-react";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: auth, isLoading } = useGetDashboardAuthMe({
    query: { queryKey: getGetDashboardAuthMeQueryKey(), retry: false },
  });

  React.useEffect(() => {
    if (!isLoading && !auth?.authenticated && location !== "/") {
      setLocation("/");
    }
  }, [auth, isLoading, location, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!auth?.authenticated && location !== "/") {
    return null;
  }

  return <>{children}</>;
}
