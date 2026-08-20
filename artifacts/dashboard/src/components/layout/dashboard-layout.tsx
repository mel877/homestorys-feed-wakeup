import React, { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  BarChart, 
  Activity, 
  Package, 
  LogOut,
  Database,
  Globe2,
  Rss,
  TrendingUp,
  ScrollText,
} from "lucide-react";
import { useDashboardLogout, getGetDashboardAuthMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/overview", label: "Overview", icon: BarChart },
  { href: "/runs", label: "Sync Runs", icon: Activity },
  { href: "/products", label: "Products", icon: Package },
  { href: "/google", label: "Google", icon: Globe2 },
  { href: "/meta", label: "Meta", icon: Rss },
  { href: "/feeds", label: "Feeds", icon: Database },
  { href: "/rules", label: "Channel Rules", icon: ScrollText },
];

export function DashboardLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const logout = useDashboardLogout();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDashboardAuthMeQueryKey() });
      }
    });
  };

  return (
    <div className="min-h-[100dvh] bg-background flex font-sans">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-50 w-[224px] bg-sidebar border-r border-border flex flex-col">
        <div className="h-16 px-4 flex items-center shrink-0">
          <Link href="/overview" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-[#0a0a0a] flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold leading-none mb-1">AI</span>
              <span className="text-[14px] font-semibold tracking-tight leading-none text-foreground">Feed Engine</span>
            </div>
          </Link>
        </div>
        
        <div className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-6">
          <div>
            <div className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground px-3 mb-2">Operations</div>
            <nav className="flex flex-col gap-1">
              {NAV_ITEMS.map((item) => {
                const isActive = location === item.href || location.startsWith(item.href + "/");
                
                return (
                  <Link 
                    key={item.href} 
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-[18px] text-[13px] font-medium transition-colors group",
                      isActive 
                        ? "bg-[#0a0a0a] text-white" 
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <item.icon className={cn(
                      "w-4 h-4 shrink-0 transition-opacity",
                      isActive ? "text-white opacity-100" : "opacity-[0.4] group-hover:opacity-100"
                    )} />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>

        <div className="p-4 border-t border-border mt-auto shrink-0 flex items-center justify-between">
           <div className="text-[12px] font-medium text-muted-foreground cursor-pointer hover:text-foreground">
             <span className="text-foreground">EN</span> / FR
           </div>
           <Button 
              variant="ghost" 
              size="icon"
              className="w-8 h-8 rounded-full"
              onClick={handleLogout}
              disabled={logout.isPending}
            >
              <LogOut className="w-4 h-4" />
            </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 pl-[224px]">
        <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-sm h-16 flex items-center justify-end px-8 shrink-0">
          <Button variant="default" size="sm" asChild>
            <Link href="/overview">Run Sync</Link>
          </Button>
        </header>
        <div className="w-full max-w-[1280px] mx-auto px-8 pb-24 flex-1">
          {children}
        </div>
      </main>
    </div>
  );
}
