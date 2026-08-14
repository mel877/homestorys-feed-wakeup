import React from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useDashboardLogin, getGetDashboardAuthMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { TrendingUp } from "lucide-react";

const loginSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

export default function Login() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const login = useDashboardLogin();

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { password: "" },
  });

  const onSubmit = (data: z.infer<typeof loginSchema>) => {
    login.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDashboardAuthMeQueryKey() });
        setLocation("/overview");
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Login Failed",
          description: err.message || "Invalid password",
        });
      }
    });
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-6 font-sans">
      <div className="w-full max-w-[360px] bg-card p-8 rounded-[20px] shadow-card border border-border">
        <div className="text-center mb-8 flex flex-col items-center">
          <div className="w-12 h-12 rounded-[14px] bg-[#0a0a0a] flex items-center justify-center mb-6">
            <TrendingUp className="w-6 h-6 text-white" />
          </div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-semibold mb-1">AI</div>
          <h1 className="text-[24px] font-bold tracking-tight text-foreground">Feed Engine</h1>
          <p className="text-[14px] text-muted-foreground mt-2">Log in to operations console</p>
        </div>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      id="password"
                      type="password"
                      placeholder="Enter Access Key"
                      className="text-center h-11 rounded-[18px] text-[14px] border-border shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="text-center text-[12px]" />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full h-11" disabled={login.isPending}>
              {login.isPending ? "Authenticating..." : "Access Console"}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}