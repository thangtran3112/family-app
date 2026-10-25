"use client";

import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LeftSlotContext } from "./DeskContext";

/** A page's left-rail content, rendered into the shell's left slot. Only the Practice replay, day list and journal have a slot. */
export function LeftRailPortal({ children }: { children: ReactNode }) {
  const slot = useContext(LeftSlotContext);
  return slot ? createPortal(children, slot) : null;
}
