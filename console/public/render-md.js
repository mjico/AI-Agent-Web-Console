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

  function isTableStart(lines, index) {
    return index + 1 < lines.length && String(lines[index]).includes("|") && isSeparator(lines[index + 1]);
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
    while (cursor < lines.length && String(lines[cursor]).includes("|") && String(lines[cursor]).trim()) {
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

  function renderMarkdown(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
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
      while (index < lines.length && lines[index].trim() && !lines[index].startsWith("```") && !/^#{1,6}\s+/.test(lines[index]) && !/^\s*[-*]\s+/.test(lines[index]) && !/^\s*\d+\.\s+/.test(lines[index]) && !/^\s*>\s?/.test(lines[index]) && !isTableStart(lines, index)) {
        para.push(lines[index]);
        index += 1;
      }
      html.push("<p>" + para.map(renderInline).join("<br>") + "</p>");
    }
    return html.join("");
  }

  root.renderMarkdown = renderMarkdown;
})(typeof globalThis !== "undefined" ? globalThis : this);
