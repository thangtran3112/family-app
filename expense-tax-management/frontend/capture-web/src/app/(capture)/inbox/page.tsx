"use client";

import { Copy, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";

export default function InboxPage() {
  const [address, setAddress] = useState("receipts+7b42a9f2…@inbound.expense-tax.local");
  const [copied, setCopied] = useState(false);
  return <><header className="page-head"><div><p className="kicker">Forwarding inbox</p><h1>Email receipts.<br />Keep scope explicit.</h1><p>Address follows the active Personal or business profile.</p></div></header><section className="inbox-grid"><article className="panel"><span className="label">Tran Studio forwarding address</span><code>{address}</code><div className="actions"><button className="primary" onClick={async () => { await navigator.clipboard?.writeText(address); setCopied(true); }}><Copy size={18} />{copied ? "Copied" : "Copy"}</button><button onClick={() => setAddress(`receipts+${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}…@inbound.expense-tax.local`)}><RefreshCw size={18} />Rotate</button></div><p className="trust"><ShieldCheck size={17} /> owner@example.test · verified</p></article><article className="panel"><h2>Recent intake</h2><ul className="timeline"><li><b>Corner Deli</b><span>Accepted · OCR processing</span></li><li className="warn"><b>Unknown sender</b><span>Quarantined · no OCR credit used</span></li><li><b>Staples</b><span>Ready for review</span></li></ul></article></section></>;
}
