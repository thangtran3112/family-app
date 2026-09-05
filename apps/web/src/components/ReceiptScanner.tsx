"use client";

import React, { useState, useRef, useEffect } from "react";
import { Camera, Upload, X, Check, RefreshCw, AlertCircle, FileText } from "lucide-react";

interface ReceiptScannerProps {
  onScanComplete?: (file: File) => void;
  onClose?: () => void;
}

export function ReceiptScanner({ onScanComplete, onClose }: ReceiptScannerProps) {
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // Start live camera stream
  const startCamera = async () => {
    setCameraError(null);
    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: "environment" }, // back camera on mobile
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setIsCameraActive(true);
    } catch (err: any) {
      setCameraError(
        err.name === "NotAllowedError"
          ? "Camera permission was denied. Please allow camera access in your browser settings, or use the file picker."
          : "Could not start camera. Please upload receipt photo directly."
      );
      setIsCameraActive(false);
    }
  };

  // Stop camera stream
  const stopCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setIsCameraActive(false);
  };

  // Capture still frame from live camera
  const captureFrame = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `receipt_${Date.now()}.jpg`, {
          type: "image/jpeg",
        });
        handleFileSelected(file);
        stopCamera();
      },
      "image/jpeg",
      0.9
    );
  };

  const handleFileSelected = (file: File) => {
    setSelectedFile(file);
    if (file.type.startsWith("image/")) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelected(e.target.files[0]);
    }
  };

  const handleConfirmUpload = async () => {
    if (!selectedFile) return;
    setIsUploading(true);
    try {
      if (onScanComplete) {
        onScanComplete(selectedFile);
      }
    } finally {
      setIsUploading(false);
    }
  };

  const resetSelection = () => {
    setSelectedFile(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setCameraError(null);
  };

  useEffect(() => {
    return () => {
      stopCamera();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return (
    <div className="relative w-full max-w-lg mx-auto bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl p-5 text-white">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-emerald-500/10 rounded-xl text-emerald-400">
            <Camera className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-zinc-100">Scan Expense Receipt</h3>
            <p className="text-xs text-zinc-400">Mobile camera capture & AI extraction</p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Main View Area */}
      <div className="mt-4">
        {/* Error Alert */}
        {cameraError && (
          <div className="p-3 mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{cameraError}</span>
          </div>
        )}

        {/* Live Camera Viewfinder */}
        {isCameraActive ? (
          <div className="relative aspect-[3/4] bg-black rounded-xl overflow-hidden border border-zinc-700">
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            {/* Guide overlay */}
            <div className="absolute inset-6 border-2 border-emerald-400/60 rounded-lg pointer-events-none flex flex-col justify-between p-2">
              <span className="text-[10px] uppercase font-mono text-emerald-400 tracking-wider">
                Align Receipt Within Box
              </span>
              <div className="self-center text-xs text-emerald-400/80 font-mono">
                Auto-Detection Active
              </div>
            </div>

            {/* Camera Controls */}
            <div className="absolute bottom-4 inset-x-0 flex items-center justify-center gap-6">
              <button
                type="button"
                onClick={stopCamera}
                className="p-3 rounded-full bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700 transition"
              >
                <X className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={captureFrame}
                className="w-16 h-16 rounded-full border-4 border-white bg-emerald-500 hover:bg-emerald-400 flex items-center justify-center shadow-lg transition active:scale-95"
              >
                <div className="w-8 h-8 rounded-full bg-white" />
              </button>
            </div>
          </div>
        ) : selectedFile ? (
          /* Captured / Selected Preview */
          <div className="space-y-4">
            <div className="relative aspect-[3/4] bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800 flex items-center justify-center">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Receipt Preview"
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="text-center p-6 text-zinc-400">
                  <FileText className="w-16 h-16 mx-auto mb-2 text-zinc-600" />
                  <p className="text-sm font-medium text-zinc-300">{selectedFile.name}</p>
                  <p className="text-xs text-zinc-500 mt-1">
                    {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB PDF Document
                  </p>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={resetSelection}
                className="flex-1 py-2.5 px-4 rounded-xl border border-zinc-700 hover:bg-zinc-800 text-sm font-medium transition flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-4 h-4" /> Retake
              </button>
              <button
                type="button"
                onClick={handleConfirmUpload}
                disabled={isUploading}
                className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-sm font-semibold transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 disabled:opacity-50"
              >
                {isUploading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" /> Processing...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" /> Upload & Scan
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          /* Empty / Trigger State */
          <div className="space-y-3">
            <button
              type="button"
              onClick={startCamera}
              className="w-full py-6 rounded-xl border-2 border-dashed border-emerald-500/30 hover:border-emerald-500/60 bg-emerald-500/5 hover:bg-emerald-500/10 transition flex flex-col items-center justify-center gap-2 group"
            >
              <div className="p-3 bg-emerald-500/20 rounded-full text-emerald-400 group-hover:scale-110 transition">
                <Camera className="w-7 h-7" />
              </div>
              <span className="font-semibold text-zinc-200">Open Mobile Camera</span>
              <span className="text-xs text-zinc-400">Scan receipt with live viewfinder</span>
            </button>

            <div className="relative flex py-2 items-center">
              <div className="flex-grow border-t border-zinc-800"></div>
              <span className="flex-shrink mx-3 text-xs text-zinc-500 uppercase">Or select file</span>
              <div className="flex-grow border-t border-zinc-800"></div>
            </div>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-3.5 px-4 rounded-xl border border-zinc-800 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-700 text-sm font-medium transition flex items-center justify-center gap-2 text-zinc-300"
            >
              <Upload className="w-4 h-4 text-zinc-400" />
              Choose Photo or PDF
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
              capture="environment"
              onChange={handleFileInputChange}
              className="hidden"
            />
          </div>
        )}
      </div>
    </div>
  );
}
