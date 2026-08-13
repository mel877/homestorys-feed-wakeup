import React, { useState } from "react";
import { useListFeedSnapshots } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Database, Download, CheckCircle2, Clock } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

export default function Feeds() {
  const [channel, setChannel] = useState("all");
  
  const { data: feeds, isLoading } = useListFeedSnapshots({
    ...(channel !== "all" && { channel }),
    currentOnly: false
  });

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Database className="w-8 h-8 text-primary" /> Generated Feeds
          </h1>
          <p className="text-muted-foreground mt-1">Raw XML/CSV files hosted in Cloud Storage</p>
        </div>
        <div className="flex items-center gap-4 bg-card p-2 rounded-lg border">
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Channel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Channels</SelectItem>
              <SelectItem value="meta">Meta</SelectItem>
              <SelectItem value="google">Google</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Locale</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Generated</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="text-center">Current</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Loading feeds...</TableCell>
                </TableRow>
              ) : feeds?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">No feeds found</TableCell>
                </TableRow>
              ) : (
                feeds?.map((feed) => (
                  <TableRow key={feed.id} className={!feed.isCurrent ? 'opacity-70 bg-muted/30' : ''}>
                    <TableCell className="font-medium capitalize">{feed.channel}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {feed.language}{feed.marketCode ? `-${feed.marketCode}` : ''}
                    </TableCell>
                    <TableCell className="font-mono">{feed.itemCount.toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="text-sm">{format(new Date(feed.generatedAt), "MMM d, HH:mm")}</div>
                      <div className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(feed.generatedAt))} ago</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs max-w-[200px] truncate text-muted-foreground" title={feed.storagePath}>
                      {feed.storagePath.split('/').pop()}
                    </TableCell>
                    <TableCell className="text-center">
                      {feed.isCurrent ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600 mx-auto" />
                      ) : (
                        <Clock className="w-4 h-4 text-muted-foreground mx-auto" />
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {feed.downloadUrl ? (
                        <a href={feed.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-8 w-8 text-primary">
                          <Download className="w-4 h-4" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">Expired</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
