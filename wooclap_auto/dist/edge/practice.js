
    const diagram = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="130" viewBox="0 0 180 130"><rect width="180" height="130" rx="16" fill="#eff6ff"/><path d="M90 18 157 112H23Z" fill="#4b80de" stroke="#2451a1" stroke-width="3"/></svg>');
    const questions = [
      { id: 'math', title: 'What is 6 × 7?', type: 'Single answer', choices: [['math-36', '36'], ['math-42', '42'], ['math-48', '48']] },
      { id: 'primes', title: 'Which of these numbers are prime? Select all that apply.', type: 'Multiple answers', multiple: true, choices: [['prime-2', '2'], ['prime-4', '4'], ['prime-5', '5'], ['prime-9', '9']] },
      { id: 'truefalse', title: 'Water freezes at 0°C at standard atmospheric pressure.', type: 'True or false', choices: [['true', 'True'], ['false', 'False']] },
      { id: 'shape', title: 'How many sides does the shape shown have?', type: 'Image question', image: diagram, choices: [['sides-3', '3'], ['sides-4', '4'], ['sides-5', '5']] }
    ];
    const mount = document.getElementById('question-mount');
    const picker = document.getElementById('question-picker');
    const confirmation = document.querySelector('[data-wooclap-confirmation]');
    const waiting = document.querySelector('[data-wooclap-waiting]');
    let occurrence = 0;
    let currentIndex = 0;
    let submissions = 0;
    function showQuestion(index) {
      currentIndex = index;
      picker.value = String(index);
      const question = questions[index];
      occurrence += 1;
      confirmation.hidden = true;
      waiting.hidden = true;
      document.getElementById('question-kind').textContent = question.type;
      const form = document.createElement('form');
      form.setAttribute('data-wooclap-question', '');
      form.setAttribute('data-question-id', question.id + '-' + occurrence);
      const heading = document.createElement('h2');
      heading.setAttribute('data-wooclap-question-text', '');
      heading.textContent = question.title;
      form.append(heading);
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = question.multiple ? 'Choose every correct answer, then submit.' : 'Choose one answer, then submit.';
      form.append(hint);
      if (question.image) {
        const img = document.createElement('img');
        img.src = question.image;
        img.alt = 'A blue triangle';
        img.className = 'visual';
        form.append(img);
      }
      const choices = document.createElement('div');
      choices.className = 'choices';
      for (const [id, text] of question.choices) {
        const label = document.createElement('label');
        label.className = 'choice';
        const input = document.createElement('input');
        input.type = question.multiple ? 'checkbox' : 'radio';
        input.name = 'answer';
        input.id = id;
        input.value = id;
        input.setAttribute('data-choice-id', id);
        const span = document.createElement('span');
        span.textContent = text;
        label.append(input, span);
        choices.append(label);
      }
      form.append(choices);
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'primary submit';
      submit.setAttribute('data-wooclap-submit', '');
      submit.textContent = 'Submit answer';
      form.append(submit);
      const error = document.createElement('p');
      error.className = 'error';
      error.setAttribute('role', 'alert');
      form.append(error);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const selected = [...form.querySelectorAll('input:checked')];
        if (!selected.length) { error.textContent = 'Choose an answer before submitting.'; return; }
        if (form.dataset.submitted === 'true') return;
        form.dataset.submitted = 'true';
        submissions += 1;
        document.getElementById('submission-count').textContent = String(submissions);
        document.getElementById('submitted-detail').textContent = 'Your selection: ' + selected.map(input => question.choices.find(choice => choice[0] === input.value)[1]).join(', ');
        mount.replaceChildren();
        confirmation.hidden = false;
      });
      mount.replaceChildren(form);
    }
    document.getElementById('show-question').addEventListener('click', () => showQuestion(Number(picker.value)));
    document.getElementById('next-question').addEventListener('click', () => showQuestion((currentIndex + 1) % questions.length));
    document.getElementById('repeat-question').addEventListener('click', () => showQuestion(currentIndex));
    document.getElementById('show-waiting').addEventListener('click', () => {
      mount.replaceChildren(); confirmation.hidden = true; waiting.hidden = false;
      document.getElementById('question-kind').textContent = 'Waiting';
    });
    const startedAt = Date.now();
    setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      document.getElementById('timer').textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    }, 1000);
    showQuestion(0);
  