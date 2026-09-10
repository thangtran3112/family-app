import { SignIn } from "@clerk/nextjs";
export default function PlatformLogin(){return <main className="login"><SignIn routing="path" path="/platform-login"/></main>}
