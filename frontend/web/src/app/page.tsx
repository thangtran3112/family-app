"use client";

import React, { useState, useEffect } from "react";
import {
  Receipt,
  DollarSign,
  TrendingUp,
  Cpu,
  Layers,
  ShieldCheck,
  Camera,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Plus,
  BarChart3,
  Calendar
} from "lucide-react";
import { ReceiptScanner } from "@/components/ReceiptScanner";
import { api, HealthResponse } from "@/lib/api";

export default function Dashboard() {
  const [backendHealth, setBackendHealth] = useState<HealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"dashboard" | "scanner">("dashboard");

  useEffect(() => {
    async function checkHealth() {
      try {
        const res = await api.getHealth();
        setBackendHealth(res);
      } catch (err) {
        setBackendHealth(null);
      } finally {
        setHealthLoading(false);
      }
    }
    checkHealth();
  }, []);

  const handleScanCompleted = (file: File) => {
    alert(`Receipt captured: ${file.name} (${(file.size / 1024).toFixed(1)} KB). Ready for FastAPI upload.`);
    setIsScannerOpen(false);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 selection:bg-emerald-500 selection:text-black">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-40 backdrop-blur-md bg-zinc-950/80 border-b border-zinc-800/80 px-4 sm:px-8 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <Receipt className="w-5 h-5 text-zinc-950" />
          </div>
          <div>
            <span className="font-bold text-base tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
              ExpenseTax
            </span>
            <span className="ml-2 text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              PWA v0.1
            </span>
          </div>
        </div>

        {/* Status Badges */}
        <div className="flex items-center gap-2">
          {/* Tenant Badge */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-medium text-zinc-300">
            <Layers className="w-3.5 h-3.5 text-zinc-400" />
            <span>Tenant: <strong>Family</strong></span>
          </div>

          {/* Backend Status Badge */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs">
            {healthLoading ? (
              <span className="w-2 h-2 rounded-full bg-zinc-500 animate-pulse" />
            ) : backendHealth?.status === "healthy" ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                <span className="text-zinc-300 font-mono text-[11px]">FastAPI Ready</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <span className="text-amber-400 font-mono text-[11px]">API Offline</span>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Banner Alert if Backend is Ready */}
        {backendHealth && (
          <div className="p-4 rounded-2xl bg-zinc-900/60 border border-emerald-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-zinc-300">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <span>
                Connected to <strong>{backendHealth.service}</strong> v{backendHealth.version} (Python 3.13 + FastAPI).
              </span>
            </div>
            <a
              href="http://localhost:8000/docs"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 font-semibold transition self-start sm:self-auto"
            >
              OpenAPI Swagger Docs <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        )}

        {/* Primary Mobile Action: Scan Receipt */}
        <section className="bg-gradient-to-b from-zinc-900 to-zinc-900/60 border border-zinc-800/80 rounded-3xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
          <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
          
          <div className="max-w-xl space-y-3">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
              <ShieldCheck className="w-3.5 h-3.5" /> Tax Deduction Engine
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Scan & Categorize Expenses Instantly
            </h1>
            <p className="text-zinc-400 text-sm leading-relaxed">
              Snap a receipt with your phone camera. Our Python backend extracts structured line items, computes tax attribution, and links to your temporal knowledge graph.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => setIsScannerOpen(true)}
              className="px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold text-sm transition flex items-center gap-2.5 shadow-lg shadow-emerald-500/25 active:scale-95"
            >
              <Camera className="w-4 h-4" />
              Open Camera Scanner
            </button>
            <button
              onClick={() => setIsScannerOpen(true)}
              className="px-5 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700/80 text-zinc-200 font-medium text-sm border border-zinc-700/80 transition flex items-center gap-2"
            >
              <Plus className="w-4 h-4 text-zinc-400" />
              Upload Document (PDF/Image)
            </button>
          </div>
        </section>

        {/* Live Scanner Drawer / Modal */}
        {isScannerOpen && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <ReceiptScanner
              onClose={() => setIsScannerOpen(false)}
              onScanComplete={handleScanCompleted}
            />
          </div>
        )}

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Card 1: Total Expenses */}
          <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800/80 space-y-2">
            <div className="flex items-center justify-between text-zinc-400 text-xs font-medium">
              <span>March 2026 Expenses</span>
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-white">$0.00</div>
            <p className="text-[11px] text-zinc-500 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Ready for first scan
            </p>
          </div>

          {/* Card 2: Tax Deductible */}
          <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800/80 space-y-2">
            <div className="flex items-center justify-between text-zinc-400 text-xs font-medium">
              <span>Tax Deductible</span>
              <TrendingUp className="w-4 h-4 text-teal-400" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-white">$0.00</div>
            <p className="text-[11px] text-zinc-500">100% small business attribution</p>
          </div>

          {/* Card 3: LLM Monthly Budget */}
          <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800/80 space-y-2">
            <div className="flex items-center justify-between text-zinc-400 text-xs font-medium">
              <span>AI Extraction Budget</span>
              <Cpu className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-white">
              $0.00 <span className="text-xs font-normal text-zinc-500">/ $20.00 cap</span>
            </div>
            <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className="w-[0%] h-full bg-emerald-500 rounded-full" />
            </div>
          </div>
        </div>

        {/* Architecture & Component Status */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            System Stack & Architecture Overview
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800 space-y-2">
              <div className="flex items-center gap-2 text-white font-semibold">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <span>Presentation Layer (Client PWA)</span>
              </div>
              <p className="text-zinc-400 leading-relaxed">
                Next.js 16.3+ (React 19.2, Tailwind v4.3). Built as an installable PWA with full mobile camera viewfinder access.
              </p>
              <div className="text-[11px] text-zinc-500 font-mono">
                Route: / → Port 7331
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800 space-y-2">
              <div className="flex items-center gap-2 text-white font-semibold">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <span>Core Backend Layer (Python FastAPI)</span>
              </div>
              <p className="text-zinc-400 leading-relaxed">
                FastAPI, SQLAlchemy 2.0 (asyncpg), Alembic, Pydantic v2. Multi-tenancy isolation and JWT authentication ready.
              </p>
              <div className="text-[11px] text-zinc-500 font-mono">
                Route: /api/v1/ → Port 8000
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
