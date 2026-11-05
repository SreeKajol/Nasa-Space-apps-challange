import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Side drawer on wide screens, bottom sheet on phones. Non-modal by default
 * so the map stays usable next to it; Esc and the close button dismiss it.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  modal = false,
  side = "right",
  className,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  closeLabel: string;
  children: ReactNode;
  modal?: boolean;
  side?: "right" | "bottom";
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogPrimitive.Portal>
        {modal && <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />}
        <DialogPrimitive.Content
          onInteractOutside={(e) => !modal && e.preventDefault()}
          className={cn(
            "fixed z-50 flex flex-col gap-4 overflow-y-auto border bg-popover p-5 text-popover-foreground shadow-2xl outline-none",
            "data-[state=open]:animate-in data-[state=open]:duration-200",
            side === "right"
              ? "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl data-[state=open]:slide-in-from-bottom md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-[26rem] md:rounded-none md:rounded-l-xl md:data-[state=open]:slide-in-from-right"
              : "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl data-[state=open]:slide-in-from-bottom",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-xl font-semibold">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent" aria-label={closeLabel}>
              <X className="size-5" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Centered modal dialog (Help, About). */
export function Modal({ open, onOpenChange, title, closeLabel, children }: { open: boolean; onOpenChange(o: boolean): void; title: ReactNode; closeLabel: string; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/45 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 max-h-[88dvh] w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="mb-4 flex items-start justify-between gap-3">
            <DialogPrimitive.Title className="text-xl font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent" aria-label={closeLabel}>
              <X className="size-5" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
