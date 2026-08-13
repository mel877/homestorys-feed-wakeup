import React from "react";
import { AlertCircle, CheckCircle2, Info, XCircle, Clock } from "lucide-react";

type BadgeProps = {
  status: string;
  className?: string;
};

export function StatusBadge({ status, className = "" }: BadgeProps) {
  const s = status.toLowerCase();
  
  let color = "bg-gray-100 text-gray-800 border-gray-200";
  let Icon = Info;

  if (s === "success" || s === "active" || s === "completed" || s === "in_stock") {
    color = "bg-green-100 text-green-800 border-green-200";
    Icon = CheckCircle2;
  } else if (s === "error" || s === "failed" || s === "out_of_stock") {
    color = "bg-red-100 text-red-800 border-red-200";
    Icon = XCircle;
  } else if (s === "warning" || s === "pending" || s === "in_progress") {
    color = "bg-yellow-100 text-yellow-800 border-yellow-200";
    Icon = Clock;
  } else if (s === "info" || s === "eligible") {
    color = "bg-blue-100 text-blue-800 border-blue-200";
    Icon = Info;
  }

  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${color} ${className}`}>
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}
