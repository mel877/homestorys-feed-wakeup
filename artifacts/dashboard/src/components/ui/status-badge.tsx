import React from "react";
import { cn } from "@/lib/utils";

interface StatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  status: string;
  label?: string;
  variant?: "pill" | "dot";
}

export function StatusBadge({ status, label, variant = "pill", className, ...props }: StatusBadgeProps) {
  const normalizedStatus = status?.toLowerCase() || '';
  
  const isSuccess = ["success", "completed", "active", "eligible", "true", "yes", "published", "healthy", "available"].includes(normalizedStatus);
  const isWarning = ["warning", "pending", "running", "partial", "degraded"].includes(normalizedStatus);
  const isError = ["error", "failed", "inactive", "false", "no", "rejected", "fatal", "excluded", "unavailable"].includes(normalizedStatus);
  const isGrey = ["awaiting launch"].includes(normalizedStatus);
  
  const displayLabel = label || status || '--';
  
  if (variant === "dot") {
    return (
      <div className={cn("flex items-center gap-1.5", className)} {...props}>
        <div className={cn(
          "w-1.5 h-1.5 rounded-full",
          isSuccess && "bg-[hsl(142,71%,45%)]",
          isWarning && "bg-[hsl(38,92%,50%)]",
          isError && "bg-[#e7000b]",
          isGrey && "bg-[hsl(0,0%,45.1%)]",
          !isSuccess && !isWarning && !isError && !isGrey && "bg-black"
        )} />
        <span className="text-[12px] font-medium capitalize text-foreground">{displayLabel}</span>
      </div>
    );
  }

  return (
    <div 
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[12px] font-medium capitalize whitespace-nowrap",
        isSuccess && "bg-[hsl(142,71%,45%,0.1)] text-[hsl(142,71%,45%)] border border-[hsl(142,71%,45%,0.2)]",
        isWarning && "bg-[hsl(38,92%,50%,0.1)] text-[hsl(38,92%,50%)] border border-[hsl(38,92%,50%,0.2)]",
        isError && "bg-[#e7000b1a] text-[#e7000b] border border-[#e7000b33]",
        isGrey && "bg-[hsl(0,0%,45.1%,0.1)] text-[hsl(0,0%,45.1%)] border border-[hsl(0,0%,45.1%,0.2)]",
        !isSuccess && !isWarning && !isError && !isGrey && "bg-[#0a0a0a1a] text-[#0a0a0a] border border-[#0a0a0a33]",
        className
      )}
      {...props}
    >
      <div className={cn(
          "w-1.5 h-1.5 rounded-full mr-1.5 shrink-0",
          isSuccess && "bg-[hsl(142,71%,45%)]",
          isWarning && "bg-[hsl(38,92%,50%)]",
          isError && "bg-[#e7000b]",
          isGrey && "bg-[hsl(0,0%,45.1%)]",
          !isSuccess && !isWarning && !isError && !isGrey && "bg-[#0a0a0a]"
        )} />
      {displayLabel}
    </div>
  );
}
