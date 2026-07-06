import * as React from "react";

import { type LucideIcon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Props = Omit<React.ComponentProps<typeof Button>, "children"> & {
  icon: LucideIcon;
  label: string;
  iconSize?: number;
  side?: "top" | "bottom" | "left" | "right";
};

/** Icon-only button with a TEDI-style tooltip. Used across the toolbar + keys. */
export function IconButton({
  icon: Icon,
  label,
  iconSize = 16,
  side = "bottom",
  variant = "ghost",
  size = "icon-sm",
  ...rest
}: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={variant} size={size} aria-label={label} {...rest}>
          <Icon size={iconSize} strokeWidth={1.8} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
