import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  fetchArticle,
  saveReviewState,
  submitReview,
  type Article,
  type ReviewState,
} from "../lib/api";
import ParagraphCard from "./ParagraphCard";

export default function ReviewView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [article, setArticle] = useState<Article | null>(null);
  const [state, setState] = useState<ReviewState | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Coalescing save queue: serializes saves, always writes the latest state
  const saveQueueRef = useRef<{
    promise: Promise<void>;
    next: ReviewState | null;
  }>({
    promise: Promise.resolve(),
    next: null,
  });

  useEffect(() => {
    if (!id) return;
    fetchArticle(id)
      .then((data) => {
        setArticle(data);
        setState(data.state);
      })
      .catch(() => setError("Failed to load article."));
  }, [id]);

  const persist = useCallback(
    (updated: ReviewState) => {
      if (!id) return;
      setState(updated);
      saveQueueRef.current.next = updated;
      saveQueueRef.current.promise = saveQueueRef.current.promise.then(
        async () => {
          const toSave = saveQueueRef.current.next;
          if (!toSave) return;
          saveQueueRef.current.next = null;
          setSaving(true);
          try {
            await saveReviewState(id, toSave);
          } finally {
            setSaving(false);
          }
        },
      );
    },
    [id],
  );

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (error) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <p style={{ color: "var(--color-revised)" }}>{error}</p>
      </div>
    );
  }

  if (!article || !state) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <p style={{ color: "var(--color-text-muted)" }}>Loading...</p>
      </div>
    );
  }

  const readonly = state.submitted;
  const orderedParagraphs = state.order.map((idx) => state.paragraphs[idx]);
  const reviewed = state.paragraphs.filter(
    (p) => p.status !== "pending",
  ).length;
  const total = state.paragraphs.length;
  const allReviewed = reviewed === total;
  const progress = total > 0 ? (reviewed / total) * 100 : 0;

  function handleApprove(index: number) {
    if (readonly) return;
    const updated = { ...state! };
    updated.paragraphs = updated.paragraphs.map((p) =>
      p.index === index
        ? { ...p, status: "approved" as const, notes: null }
        : p,
    );
    persist(updated);
  }

  function handleUpdateNotes(index: number, notes: string) {
    if (readonly) return;
    const updated = { ...state! };
    updated.paragraphs = updated.paragraphs.map((p) =>
      p.index === index
        ? {
            ...p,
            status: notes.trim() ? ("revised" as const) : ("pending" as const),
            notes: notes || null,
          }
        : p,
    );
    persist(updated);
  }

  function handleRevise(index: number) {
    if (readonly) return;
    const updated = { ...state! };
    updated.paragraphs = updated.paragraphs.map((p) =>
      p.index === index ? { ...p, status: "pending" as const, notes: null } : p,
    );
    persist(updated);
  }

  function handleDragEnd(event: DragEndEvent) {
    if (readonly) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = state!.order.indexOf(active.id as number);
    const newIndex = state!.order.indexOf(over.id as number);
    const updated = {
      ...state!,
      order: arrayMove(state!.order, oldIndex, newIndex),
    };
    persist(updated);
  }

  async function handleSubmit() {
    if (!id || readonly) return;
    setSubmitting(true);
    try {
      await saveQueueRef.current.promise; // flush any pending save
      await submitReview(id);
      navigate("/");
    } catch {
      setError("Failed to submit review. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => navigate("/")}
          className="text-sm transition-colors"
          style={{ color: "var(--color-text-muted)" }}
        >
          &larr; Dashboard
        </button>
        <div className="flex items-center gap-3">
          {saving && (
            <span
              className="text-xs"
              style={{ color: "var(--color-text-muted)" }}
            >
              Saving...
            </span>
          )}
          {state.submitted && (
            <span
              className="text-xs font-medium px-2 py-0.5 rounded"
              style={{ background: "var(--color-approved)", color: "#000" }}
            >
              Submitted
            </span>
          )}
        </div>
      </div>

      <h1
        className="text-2xl font-bold mb-1"
        style={{ color: "var(--color-text)" }}
      >
        {article.meta.title || article.filename}
      </h1>

      <div
        className="flex gap-4 text-sm mb-6"
        style={{ color: "var(--color-text-muted)" }}
      >
        {article.meta.client && <span>{article.meta.client}</span>}
        {article.meta.type && <span>{article.meta.type}</span>}
        {(article.meta.round ?? 0) > 1 && (
          <span>Round {article.meta.round}</span>
        )}
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-3 mb-8">
        <div
          className="flex-1 h-2 rounded-full overflow-hidden"
          style={{ background: "var(--color-border)" }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${progress}%`,
              background: allReviewed
                ? "var(--color-approved)"
                : "var(--color-primary)",
            }}
          />
        </div>
        <span
          className="text-sm font-medium"
          style={{ color: "var(--color-text-muted)" }}
        >
          {reviewed}/{total} reviewed
        </span>
      </div>

      {/* Paragraph list with drag-and-drop */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={state.order}
          strategy={verticalListSortingStrategy}
        >
          {orderedParagraphs.map((p) => (
            <ParagraphCard
              key={p.index}
              paragraph={p}
              readonly={readonly}
              onApprove={() => handleApprove(p.index)}
              onUpdateNotes={(notes) => handleUpdateNotes(p.index, notes)}
              onRevise={() => handleRevise(p.index)}
            />
          ))}
        </SortableContext>
      </DndContext>

      {/* Submit */}
      {!state.submitted && (
        <div className="mt-8 flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={!allReviewed || submitting}
            className="px-6 py-3 rounded-lg font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: allReviewed
                ? "var(--color-primary)"
                : "var(--color-border)",
              color: allReviewed ? "#fff" : "var(--color-text-muted)",
            }}
          >
            {submitting
              ? "Submitting..."
              : allReviewed
                ? "Submit Review"
                : `${total - reviewed} paragraphs remaining`}
          </button>
        </div>
      )}
    </div>
  );
}
