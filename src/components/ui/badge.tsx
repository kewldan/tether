import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

// Status is always dot + word, never color alone; soft fill = 12% of the hue.
const badgeVariants = cva(
  "group/badge text-caption focus-visible:outline-ring inline-flex h-5 w-fit shrink-0 items-center justify-center gap-[5px] overflow-hidden rounded-[5px] border border-transparent px-[7px] leading-none font-medium whitespace-nowrap transition-colors focus-visible:outline-2 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-selected text-secondary-foreground",
        secondary: "bg-selected text-secondary-foreground",
        brand: "bg-brand/15 text-brand",
        success: "bg-success/12 text-success",
        warning: "bg-warning/12 text-warning",
        error: "bg-error/13 text-error",
        destructive: "bg-error/13 text-error",
        info: "bg-info/13 text-info",
        outline: "border-input text-secondary-foreground",
        ghost: "text-muted-foreground hover:bg-accent",
        link: "text-brand underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
