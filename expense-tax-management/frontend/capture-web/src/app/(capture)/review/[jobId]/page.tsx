import { OcrReviewScreen } from "@/components/ocr-review-form";

export default async function ReviewPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <OcrReviewScreen jobId={jobId} />;
}
