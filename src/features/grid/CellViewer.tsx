/**
 * "View full value" dialog for long, structured and binary cells.
 *
 * The grid truncates with an ellipsis, so this is where a JSON document, a long
 * text value or a byte string can actually be read (and copied) in full.
 */

import * as React from "react";
import { Copy, WrapText } from "lucide-react";
import { toast } from "sonner";

import { Badge, Button, IconButton } from "@/components/ui/primitives";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/overlays";
import { type ColumnMeta, type Value, formatFloat, isNull } from "@/lib/types";
import { cn, formatCount } from "@/lib/utils";
import { useSettings } from "@/store/settings";

export interface CellViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  column: ColumnMeta | null;
  value: Value | null | undefined;
  /** 1-based row number, when the caller knows it. */
  rowNumber?: number | null;
}

/** Byte strings arrive base64 encoded and stay that way; this is the size. */
function byteLength(value: Value | null | undefined): number {
  if (!value || value.t !== "bytes") return 0;
  return value.len ?? Math.floor((value.v.length * 3) / 4);
}

/** Pretty-print JSON when it parses; otherwise hand back what the server sent. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function rawText(value: Value | null | undefined): string {
  if (!value) return "";
  switch (value.t) {
    case "null":
      return "";
    case "bool":
      return value.v ? "true" : "false";
    case "int":
    case "uint":
      return String(value.v);
    case "float":
      return formatFloat(value.v);
    case "bytes":
      return value.v;
    default:
      return value.v;
  }
}

export function CellViewer({
  open,
  onOpenChange,
  column,
  value,
  rowNumber,
}: CellViewerProps): React.ReactElement {
  const nullDisplay = useSettings((state) => state.settings.nullDisplay);
  const [wrap, setWrap] = React.useState(true);
  const [formatted, setFormatted] = React.useState(true);

  const raw = rawText(value);
  const isJson = value?.t === "json" || column?.logicalType === "json";
  const text = isJson && formatted ? prettyJson(raw) : raw;
  const empty = isNull(value);

  // Re-arm the toggles for the next cell rather than remembering the last one.
  React.useEffect(() => {
    if (open) {
      setFormatted(true);
      setWrap(true);
    }
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(isNull(value) ? "" : text);
      toast.success("Value copied");
    } catch {
      toast.error("Clipboard is unavailable");
    }
  };

  const title = column ? column.name : "Value";
  const description = [
    column?.typeName,
    rowNumber ? `row ${formatCount(rowNumber)}` : null,
    value?.t === "bytes" ? `${formatCount(byteLength(value))} bytes` : null,
    !empty ? `${formatCount(raw.length)} characters` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title={title}
          description={description || undefined}
          icon={<WrapText className="size-4" />}
        />
        <DialogBody className="p-0">
          {empty ? (
            <p className="p-4 text-[13px] italic text-grid-null">{nullDisplay}</p>
          ) : (
            <pre
              className={cn(
                "selectable m-3 max-h-[60vh] overflow-auto scrollbar-thin rounded-md border border-border",
                "bg-sunken p-3 font-mono text-[12px] leading-relaxed text-fg",
                wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
              )}
            >
              {text}
            </pre>
          )}
        </DialogBody>
        <DialogFooter className="justify-between">
          <div className="flex items-center gap-2">
            {column ? <Badge tone="neutral">{column.logicalType}</Badge> : null}
            {value?.t === "bytes" ? <Badge tone="info">binary</Badge> : null}
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              label={wrap ? "Disable wrapping" : "Wrap long lines"}
              onClick={() => setWrap((current) => !current)}
              className={wrap ? "bg-hover text-fg" : undefined}
            >
              <WrapText className="size-3.5" />
            </IconButton>
            {isJson ? (
              <Button size="sm" onClick={() => setFormatted((current) => !current)}>
                {formatted ? "Raw" : "Format"}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void copy()} disabled={empty}>
              <Copy className="size-3.5" />
              Copy
            </Button>
            <Button size="sm" variant="primary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
