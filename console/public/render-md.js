(function (root) {
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderInline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return html;
  }

  function splitCells(line) {
    let text = String(line || "").trim();
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|")) text = text.slice(0, -1);
    return text.split("|").map((cell) => cell.trim());
  }

  function isSeparator(line) {
    const cells = splitCells(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isTableRow(line) {
    const text = String(line || "").trim();
    return text.includes("|") && !isSeparator(text);
  }

  function isTableStart(lines, index) {
    return index + 1 < lines.length && isTableRow(lines[index]) && isSeparator(lines[index + 1]);
  }

  function alignOf(cell) {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  }

  function renderTable(lines, index) {
    const header = splitCells(lines[index]);
    const align = splitCells(lines[index + 1]).map(alignOf);
    const body = [];
    let cursor = index + 2;
    while (cursor < lines.length && isTableRow(lines[cursor]) && String(lines[cursor]).trim()) {
      body.push(splitCells(lines[cursor]));
      cursor += 1;
    }
    const cells = (row, tag) => row.map((cell, cellIndex) => {
      const alignName = align[cellIndex] || "left";
      return "<" + tag + ' style="text-align:' + alignName + '">' + renderInline(cell) + "</" + tag + ">";
    }).join("");
    const html = '<div class="table-wrap"><table><thead><tr>' + cells(header, "th") + "</tr></thead><tbody>"
      + body.map((row) => "<tr>" + cells(row, "td") + "</tr>").join("")
      + "</tbody></table></div>";
    return { html, next: cursor };
  }

  function normalizeChunk(text) {
    let value = String(text || "");
    // Headings jammed onto the previous sentence, with or without a space: "text。##标题"
    value = value.replace(/([^\n#])(#{1,6})(\s*)(\S)/g, "$1\n$2 $4");
    // Table starting on the same line after a colon/period: "模块：|模型 |路径 |"
    value = value.replace(/([：:。；;！!？?）)\]])\s*(\|[^|\n]+\|)/g, "$1\n$2");
    // Separator jammed with the next row: "|---|---|| cell | cell |"
    value = value.replace(/((?:\|?\s*:?-{3,}:?\s*){2,}\|?)(?=\|[^-\n])/g, "$1\n");
    return value;
  }

  function normalizeMarkdown(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/(```[\s\S]*?```)/)
      .map((chunk) => (chunk.startsWith("```") ? chunk : normalizeChunk(chunk)))
      .join("");
  }

  function renderMarkdown(text) {
    const lines = normalizeMarkdown(text).split("\n");
    const html = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (line.startsWith("```")) {
        const lang = line.slice(3).trim().toLowerCase();
        const body = [];
        index += 1;
        while (index < lines.length && !lines[index].startsWith("```")) {
          body.push(lines[index]);
          index += 1;
        }
        const closed = index < lines.length && lines[index].startsWith("```");
        if (closed) index += 1;
        const code = body.join("\n");
        if (closed && lang === "mermaid") html.push('<div class="mermaid">' + escapeHtml(code) + "</div>");
        else {
          const label = lang ? '<span class="lang">' + escapeHtml(lang) + "</span>" : "";
          html.push("<pre>" + label + "<code>" + escapeHtml(code) + "</code></pre>");
        }
        continue;
      }
      if (isTableStart(lines, index)) {
        const table = renderTable(lines, index);
        html.push(table.html);
        index = table.next;
        continue;
      }
      // Prose and a table header jammed on one line: "说明文字 |模型 |路径 |"
      const jammed = /^(.*?)(\|[^|\n]+\|[^|\n]*\|.*)$/.exec(line);
      if (jammed && index + 1 < lines.length && isSeparator(lines[index + 1])) {
        const before = jammed[1].trim();
        if (before) html.push("<p>" + renderInline(before) + "</p>");
        const tableLines = [jammed[2], ...lines.slice(index + 1)];
        const table = renderTable(tableLines, 0);
        html.push(table.html);
        index += table.next;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
        index += 1;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
          items.push("<li>" + renderInline(lines[index].replace(/^\s*[-*]\s+/, "")) + "</li>");
          index += 1;
        }
        html.push("<ul>" + items.join("") + "</ul>");
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
          items.push("<li>" + renderInline(lines[index].replace(/^\s*\d+\.\s+/, "")) + "</li>");
          index += 1;
        }
        html.push("<ol>" + items.join("") + "</ol>");
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        html.push("<blockquote>" + renderInline(quote.join(" ")) + "</blockquote>");
        continue;
      }
      if (!line.trim()) {
        index += 1;
        continue;
      }
      const para = [];
      while (
        index < lines.length
        && lines[index].trim()
        && !lines[index].startsWith("```")
        && !/^#{1,6}\s+/.test(lines[index])
        && !/^\s*[-*]\s+/.test(lines[index])
        && !/^\s*\d+\.\s+/.test(lines[index])
        && !/^\s*>\s?/.test(lines[index])
        && !isTableStart(lines, index)
        && !(
          /^(.*?)(\|[^|\n]+\|[^|\n]*\|.*)$/.test(lines[index])
          && index + 1 < lines.length
          && isSeparator(lines[index + 1])
        )
      ) {
        para.push(lines[index]);
        index += 1;
      }
      html.push("<p>" + para.map(renderInline).join("<br>") + "</p>");
    }
    return html.join("");
  }

  root.renderMarkdown = renderMarkdown;
})(typeof globalThis !== "undefined" ? globalThis : this);
