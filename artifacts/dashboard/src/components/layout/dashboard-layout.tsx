import React, { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  BarChart, 
  Activity, 
  Package, 
  Settings, 
  Image as ImageIcon, 
  LogOut,
  Boxes,
  Database,
  Globe2,
  AlertTriangle,
  Menu,
  Rss
} from "lucide-react";
import { useDashboardLogout } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { getGetDashboardAuthMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const NAV_ITEMS = [
  { href: "/overview", label: "Overview", icon: BarChart },
  { href: "/runs", label: "Sync Runs", icon: Activity },
  { href: "/products", label: "Products", icon: Package },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/images", label: "Images", icon: ImageIcon },
  { href: "/data-quality", label: "Data Quality", icon: Database },
  { href: "/google", label: "Google Channel", icon: Globe2 },
  { href: "/meta", label: "Meta Channel", icon: Rss },
  { href: "/feeds", label: "Feeds", icon: Database },
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
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-sidebar text-sidebar-foreground flex-shrink-0 flex flex-col border-r border-sidebar-border hidden md:flex">
        <div className="p-4 flex items-center gap-3 border-b border-sidebar-border/50">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground font-bold">
            H
          </div>
          <span className="font-semibold tracking-tight">Homestorys Ops</span>
        </div>
        
        <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href || location.startsWith(item.href + "/");
            const Icon = item.icon;
            
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  isActive 
                    ? "bg-sidebar-accent text-sidebar-accent-foreground" 
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border/50">
          <Button 
            variant="ghost" 
            className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
            onClick={handleLogout}
            disabled={logout.isPending}
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="h-full overflow-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
