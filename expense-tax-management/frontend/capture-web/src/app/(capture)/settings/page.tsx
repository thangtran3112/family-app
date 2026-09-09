import Link from "next/link";

export default function SettingsPage() {
  return <><header className="page-head"><div><p className="kicker">Account + profile</p><h1>Small controls,<br />clear scope.</h1><p>Dense administration stays in Office.</p></div></header><section className="settings-grid"><article className="panel"><h2>Active profile</h2><button className="profile-choice active">Tran Studio <span>Business · Owner</span></button><button className="profile-choice">Personal <span>Owner</span></button></article><article className="panel"><h2>Office handoff</h2><p>Open ledger, projects, tax preparation, and export history on a laptop.</p><Link className="primary link-button" href={process.env.NEXT_PUBLIC_OFFICE_URL ?? "http://localhost:7302"}>Open ExpenseTax Office</Link></article><article className="panel"><h2>Install Capture</h2><p>Use the browser install action for a camera-first standalone experience.</p></article></section></>;
}
