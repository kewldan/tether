import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

// Tether buttons (docs/design/project/Components.dc.html): 30 px controls,
// 26 px small, press scales to .97 on the snappy spring.
const buttonVariants = cva(
  "group/button text-body ease-spring-snappy focus-visible:outline-ring aria-invalid:border-destructive inline-flex shrink-0 items-center justify-center rounded-[7px] border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-[background-color,color,border-color,transform] duration-[340ms] outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 active:not-aria-[haspopup]:scale-[.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        outline:
          "border-input bg-card text-foreground hover:bg-accent aria-expanded:bg-accent",
        secondary:
          "border-input bg-card text-foreground hover:bg-accent aria-expanded:bg-accent",
        ghost:
          "text-secondary-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "text-brand underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[30px] gap-1.5 px-3",
        xs: "text-caption h-6 gap-1 rounded-md px-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "text-small h-[26px] gap-[5px] rounded-md px-[9px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-2 px-4",
        icon: "size-[30px]",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-[26px] rounded-md",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
