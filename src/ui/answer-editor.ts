import type { Answer, Question } from '../shared/types';

/** Render answer data as text and form controls, never as page/model HTML. */
export function renderAnswerEditor(container: HTMLElement, question: Question, answer: Answer, onChange: () => void): void {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const add = (label: string, value: string, change?: (value: string) => void, options?: { id: string; text: string }[]) => {
    const row = doc.createElement('li');
    const wrapper = doc.createElement('label');
    wrapper.className = 'answer-field';
    const caption = doc.createElement('span'); caption.textContent = label; wrapper.append(caption);
    if (change) {
      const input = options ? doc.createElement('select') : doc.createElement('textarea');
      if (input.tagName === 'SELECT') {
        for (const option of options!) {
          const item = doc.createElement('option'); item.value = option.id; item.textContent = option.text; input.append(item);
        }
      } else (input as HTMLTextAreaElement).rows = 2;
      input.value = value;
      input.addEventListener('input', () => { change(input.value); onChange(); });
      wrapper.append(input);
    } else {
      const text = doc.createElement('span'); text.textContent = value; wrapper.append(text);
    }
    row.append(wrapper); container.append(row);
  };
  const editable = !answer.needsReview && question.application !== 'preview';
  if (answer.value !== undefined) add(question.kind === 'numeric' ? 'Number to submit' : 'Response to submit', answer.value,
    editable ? value => { answer.value = value; } : undefined);
  for (const entry of answer.values ?? []) {
    const field = question.fields?.find(field => field.id === entry.id);
    const label = field?.label || question.choices.find(choice => choice.id === entry.id)?.text || entry.id;
    const options = field?.kind === 'select' ? field.options : undefined;
    add(label, entry.value, editable ? value => { entry.value = value; } : undefined, options);
  }
  for (const point of answer.points ?? []) {
    const label = question.choices.find(choice => choice.id === point.id)?.text || point.id;
    add(label, `${(point.x * 100).toFixed(1)}% from left, ${(point.y * 100).toFixed(1)}% from top of the image`);
  }
  for (const [index, id] of answer.selectedChoiceIds.entries()) {
    add(question.kind === 'sorting' ? String(index + 1) : '\u2713', question.choices.find(choice => choice.id === id)?.text ?? `Unknown choice: ${id}`);
  }
}
