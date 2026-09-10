import { SignIn } from "@clerk/nextjs";

export default function Login() { return <main className="auth"><SignIn routing="path" path="/login" /></main>; }
