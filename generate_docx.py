"""Generate a professional Word document from the project submission content."""

from docx import Document
from docx.shared import Pt, Inches, Cm, RGBColor, Emu
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_ORIENT
from docx.oxml.ns import qn, nsdecls
from docx.oxml import OxmlElement, parse_xml
import os

doc = Document()

# ── Color Palette ──────────────────────────────────────────────────────
NAVY         = RGBColor(0x0F, 0x2B, 0x46)  # deep navy for headings
NAVY_HEX     = '0F2B46'
ACCENT       = RGBColor(0x1A, 0x6B, 0xB5)  # bright blue accent
ACCENT_HEX   = '1A6BB5'
ACCENT_LIGHT  = 'D6EAFB'                    # light accent background
BODY_COLOR   = RGBColor(0x22, 0x22, 0x22)
SUBTLE_GRAY  = RGBColor(0x66, 0x66, 0x66)
ROW_ALT      = 'F0F5FA'                     # alternating row color
WHITE_HEX    = 'FFFFFF'
GAP_RED      = RGBColor(0xB8, 0x27, 0x1A)

# ── Global style defaults ──────────────────────────────────────────────
style = doc.styles['Normal']
font = style.font
font.name = 'Calibri'
font.size = Pt(11)
font.color.rgb = BODY_COLOR
style.paragraph_format.space_after = Pt(6)
style.paragraph_format.space_before = Pt(2)
style.paragraph_format.line_spacing = 1.2

# Heading styles
for lvl in range(1, 4):
    h_style = doc.styles[f'Heading {lvl}']
    h_style.font.name = 'Calibri'
    h_style.font.color.rgb = NAVY
    h_style.paragraph_format.space_before = Pt(18 if lvl == 1 else 12)
    h_style.paragraph_format.space_after = Pt(8 if lvl == 1 else 6)
    if lvl == 1:
        h_style.font.size = Pt(18)
    elif lvl == 2:
        h_style.font.size = Pt(14)
    else:
        h_style.font.size = Pt(12)

# Page margins
for section in doc.sections:
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.54)
    section.right_margin = Cm(2.54)

# ── Helper functions ───────────────────────────────────────────────────

def add_bottom_border(paragraph, color=ACCENT_HEX, size='6'):
    """Add a bottom border line under a paragraph."""
    pPr = paragraph._p.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), size)
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), color)
    pBdr.append(bottom)
    pPr.append(pBdr)

def add_heading_styled(text, level=1):
    h = doc.add_heading(text, level=level)
    for run in h.runs:
        run.font.color.rgb = NAVY
        run.font.name = 'Calibri'
    if level == 1:
        add_bottom_border(h, ACCENT_HEX, '8')
    return h

def add_body(text, bold=False, italic=False, indent=0):
    p = doc.add_paragraph()
    if indent:
        p.paragraph_format.left_indent = Inches(indent * 0.35)
    run = p.add_run(text)
    run.bold = bold
    run.italic = italic
    run.font.size = Pt(11)
    run.font.name = 'Calibri'
    run.font.color.rgb = BODY_COLOR
    p.paragraph_format.line_spacing = 1.2
    return p

def add_bullet(text, level=0):
    p = doc.add_paragraph(style='List Bullet')
    p.clear()
    run = p.add_run(text)
    run.font.size = Pt(11)
    run.font.name = 'Calibri'
    run.font.color.rgb = BODY_COLOR
    if level:
        p.paragraph_format.left_indent = Inches(0.5 + level * 0.4)
    p.paragraph_format.space_after = Pt(3)
    return p

def add_numbered(text, level=0):
    p = doc.add_paragraph(style='List Number')
    p.clear()
    run = p.add_run(text)
    run.font.size = Pt(11)
    run.font.name = 'Calibri'
    run.font.color.rgb = BODY_COLOR
    if level:
        p.paragraph_format.left_indent = Inches(0.5 + level * 0.4)
    p.paragraph_format.space_after = Pt(3)
    return p

def set_cell_shading(cell, color):
    shading = OxmlElement('w:shd')
    shading.set(qn('w:fill'), color)
    shading.set(qn('w:val'), 'clear')
    cell._tc.get_or_add_tcPr().append(shading)

def set_cell_margins(cell, top=60, bottom=60, left=100, right=100):
    """Set cell margins in twips."""
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for edge, val in [('top', top), ('bottom', bottom), ('start', left), ('end', right)]:
        el = OxmlElement(f'w:{edge}')
        el.set(qn('w:w'), str(val))
        el.set(qn('w:type'), 'dxa')
        tcMar.append(el)
    tcPr.append(tcMar)

def add_table(headers, rows):
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    # Header row
    for i, h in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = ''
        run = cell.paragraphs[0].add_run(h)
        run.bold = True
        run.font.size = Pt(10)
        run.font.name = 'Calibri'
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        set_cell_shading(cell, NAVY_HEX)
        set_cell_margins(cell)
    # Data rows
    for r_idx, row in enumerate(rows):
        for c_idx, val in enumerate(row):
            cell = table.rows[r_idx + 1].cells[c_idx]
            cell.text = ''
            run = cell.paragraphs[0].add_run(val)
            run.font.size = Pt(10)
            run.font.name = 'Calibri'
            run.font.color.rgb = BODY_COLOR
            if r_idx % 2 == 1:
                set_cell_shading(cell, ROW_ALT)
            set_cell_margins(cell)
    doc.add_paragraph()  # spacer
    return table

def add_spacer(height=6):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(height)
    p.paragraph_format.space_after = Pt(height)
    pf = p.paragraph_format
    pf.line_spacing = Pt(1)

def add_colored_box(text, bg_color=ACCENT_LIGHT, text_color=NAVY):
    """Add a highlighted info box using a single-cell table."""
    tbl = doc.add_table(rows=1, cols=1)
    tbl.style = 'Table Grid'
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = tbl.rows[0].cells[0]
    cell.text = ''
    run = cell.paragraphs[0].add_run(text)
    run.font.size = Pt(11)
    run.font.name = 'Calibri'
    run.font.color.rgb = text_color
    run.bold = True
    set_cell_shading(cell, bg_color)
    set_cell_margins(cell, top=100, bottom=100, left=150, right=150)
    doc.add_paragraph()

def add_page_footer():
    """Add page numbers to the footer."""
    for section in doc.sections:
        footer = section.footer
        footer.is_linked_to_previous = False
        p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)

        # Thin line above footer
        add_bottom_border_top(p, ACCENT_HEX)

        run = p.add_run('GraphRAG Code Reviewer  |  Project Submission Document  |  Page ')
        run.font.size = Pt(8)
        run.font.name = 'Calibri'
        run.font.color.rgb = SUBTLE_GRAY

        # Page number field
        fldChar1 = OxmlElement('w:fldChar')
        fldChar1.set(qn('w:fldCharType'), 'begin')
        instrText = OxmlElement('w:instrText')
        instrText.set(qn('xml:space'), 'preserve')
        instrText.text = ' PAGE '
        fldChar2 = OxmlElement('w:fldChar')
        fldChar2.set(qn('w:fldCharType'), 'end')

        run2 = p.add_run()
        run2.font.size = Pt(8)
        run2.font.name = 'Calibri'
        run2.font.color.rgb = SUBTLE_GRAY
        run2._r.append(fldChar1)
        run2._r.append(instrText)
        run2._r.append(fldChar2)

def add_bottom_border_top(paragraph, color):
    """Add a top border to paragraph (for footer separator)."""
    pPr = paragraph._p.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    top = OxmlElement('w:top')
    top.set(qn('w:val'), 'single')
    top.set(qn('w:sz'), '4')
    top.set(qn('w:space'), '4')
    top.set(qn('w:color'), color)
    pBdr.append(top)
    pPr.append(pBdr)

def add_section_divider():
    """Add a subtle line between major sections."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(12)

# Add page footer
add_page_footer()

# ══════════════════════════════════════════════════════════════════════
#  TITLE PAGE
# ══════════════════════════════════════════════════════════════════════

# Top decorative banner bar
banner = doc.add_table(rows=1, cols=1)
banner.alignment = WD_TABLE_ALIGNMENT.CENTER
bcell = banner.rows[0].cells[0]
bcell.text = ''
set_cell_shading(bcell, NAVY_HEX)
set_cell_margins(bcell, top=300, bottom=300, left=100, right=100)
bp = bcell.paragraphs[0]
bp.alignment = WD_ALIGN_PARAGRAPH.CENTER
br = bp.add_run('PROJECT SUBMISSION DOCUMENT')
br.bold = True
br.font.size = Pt(28)
br.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
br.font.name = 'Calibri'

for _ in range(3):
    doc.add_paragraph()

# Main Title
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_after = Pt(6)
run = p.add_run(
    'Graph-Augmented Retrieval-Based\nIntelligent Code Review System'
)
run.bold = True
run.font.size = Pt(22)
run.font.color.rgb = NAVY
run.font.name = 'Calibri'

# Subtitle
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(2)
p.paragraph_format.space_after = Pt(4)
run = p.add_run(
    'Using AST-Driven Dependency Analysis and Large Language Models'
)
run.bold = True
run.font.size = Pt(15)
run.font.color.rgb = ACCENT
run.font.name = 'Calibri'

# Accent line
accent_bar = doc.add_table(rows=1, cols=1)
accent_bar.alignment = WD_TABLE_ALIGNMENT.CENTER
ac = accent_bar.rows[0].cells[0]
ac.text = ''
set_cell_shading(ac, ACCENT_HEX)
set_cell_margins(ac, top=2, bottom=2, left=0, right=0)
# Make the bar narrow
ac.width = Inches(3)

for _ in range(3):
    doc.add_paragraph()

# Short title box
info_box = doc.add_table(rows=1, cols=1)
info_box.alignment = WD_TABLE_ALIGNMENT.CENTER
ic = info_box.rows[0].cells[0]
ic.text = ''
set_cell_shading(ic, ACCENT_LIGHT)
set_cell_margins(ic, top=120, bottom=120, left=200, right=200)
ip = ic.paragraphs[0]
ip.alignment = WD_ALIGN_PARAGRAPH.CENTER

run1 = ip.add_run('Short Title: ')
run1.font.size = Pt(12)
run1.font.name = 'Calibri'
run1.font.color.rgb = SUBTLE_GRAY

run2 = ip.add_run('GraphRAG Code Reviewer')
run2.bold = True
run2.font.size = Pt(13)
run2.font.name = 'Calibri'
run2.font.color.rgb = NAVY

ip2 = ic.add_paragraph()
ip2.alignment = WD_ALIGN_PARAGRAPH.CENTER
run3 = ip2.add_run(
    'An AI-Powered Pull Request Analysis Engine\n'
    'with Impact-Aware Dependency Traversal'
)
run3.italic = True
run3.font.size = Pt(11)
run3.font.color.rgb = SUBTLE_GRAY
run3.font.name = 'Calibri'

doc.add_page_break()

# ══════════════════════════════════════════════════════════════════════
#  1. PROJECT TITLE
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('1. Project Title', level=1)

add_body(
    'Graph-Augmented Retrieval-Based Intelligent Code Review System Using '
    'AST-Driven Dependency Analysis and Large Language Models',
    bold=True
)

add_body(
    'Short Title: GraphRAG Code Reviewer \u2014 An AI-Powered Pull Request Analysis '
    'Engine with Impact-Aware Dependency Traversal',
    italic=True
)

add_spacer()

# ══════════════════════════════════════════════════════════════════════
#  2. ABSTRACT
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('2. Abstract', level=1)

abstract_paras = [
    'Modern software development teams rely heavily on code reviews to maintain '
    'quality, yet manual reviews are time-consuming, inconsistent, and often miss '
    'subtle integration-level defects that span multiple files. This project presents '
    'a novel automated code review system that combines Retrieval-Augmented '
    'Generation (RAG) with graph-based dependency analysis to deliver '
    'context-aware, impact-sensitive pull request reviews.',

    'The system operates as a GitHub App that listens for webhook events (pull '
    'requests, pushes, and installations). Upon repository installation, the '
    'entire codebase is ingested through a three-phase pipeline: (1) Abstract '
    'Syntax Tree (AST) parsing via Babel to extract function-level symbols and '
    'their call dependencies, (2) construction of a code dependency graph stored '
    'in a PostgreSQL database (Neon), and (3) generation of semantic embeddings '
    'for each symbol using HuggingFace\u2019s sentence-transformers/all-mpnet-base-v2 '
    'model, stored in a Pinecone vector database.',

    'When a pull request is opened, the system parses the Git diff to identify '
    'changed line ranges, maps these ranges to affected code symbols using an '
    'overlap detection algorithm against the stored graph, expands the impact '
    'radius through graph traversal to find downstream dependent functions, and '
    'retrieves their source code from the vector store. This combined context \u2014 '
    'the diff itself plus the impacted downstream code \u2014 is fed to a Google '
    'Gemini LLM (Gemma 3 12B Instruction-Tuned) with a carefully engineered '
    'prompt that instructs it to detect logical regressions, breaking API '
    'changes, and integration-level defects.',

    'Early results demonstrate the system\u2019s ability to identify breaking changes '
    'that conventional line-by-line review tools miss \u2014 specifically, cases where '
    'a function signature changes but its callers in other files remain '
    'unmodified. The system also supports a conversational RAG query endpoint '
    'for semantic codebase exploration.',

    'Key contributions include: (i) a symbol-level embedding strategy that '
    'replaces naive text chunking with AST-driven code decomposition, (ii) a '
    'diff-to-graph impact retrieval mechanism that maps PR changes to '
    'downstream dependencies before LLM analysis, and (iii) a microservice '
    'architecture with asynchronous job processing via BullMQ for production-grade scalability.',
]

for para in abstract_paras:
    add_body(para)

add_spacer()

# ══════════════════════════════════════════════════════════════════════
#  3. INTRODUCTION
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('3. Introduction', level=1)

add_heading_styled('3.1 Problem Statement', level=2)
add_body(
    'Code review is a critical quality assurance practice in software engineering. '
    'However, it faces several persistent challenges:'
)
problem_bullets = [
    'Manual reviews are time-intensive and inconsistent across reviewers.',
    'Existing automated tools (linters, static analyzers) operate at the syntactic level and cannot reason about cross-file logical impact.',
    'AI-based review tools that use Large Language Models (LLMs) typically provide the model with only the diff text, lacking the broader context of how changes affect the rest of the codebase.',
    'No widely available tool combines code dependency graph analysis with semantic retrieval and LLM reasoning in a unified review pipeline.',
]
for b in problem_bullets:
    add_bullet(b)

add_heading_styled('3.2 Motivation', level=2)
add_body(
    'Consider a common scenario: a developer changes the signature of a utility '
    'function \u2014 perhaps adding a required parameter or altering its return type. '
    'The diff looks correct in isolation. A standard AI reviewer, seeing only '
    'the diff, would approve it. However, 15 other functions across the codebase '
    'call this utility, and none of them have been updated. This is an '
    'integration-level regression that only becomes visible when you understand '
    'the dependency graph.'
)
add_body(
    'This project is motivated by the need to bridge this gap: to build a '
    'review system that understands not just what changed, but what else in the '
    'codebase depends on what changed, and whether those dependencies will break.'
)

add_heading_styled('3.3 Domain Connection', level=2)
add_body('This work sits at the intersection of:')
domains = [
    'Software Engineering (automated code review, static analysis)',
    'Natural Language Processing (retrieval-augmented generation)',
    'Graph Theory (dependency graph construction and traversal)',
    'DevOps / CI-CD (GitHub App integration, webhook-driven automation)',
]
for d in domains:
    add_bullet(d)

add_heading_styled('3.4 Objectives', level=2)
objectives = [
    'Design and implement a GitHub-integrated automated code review system that goes beyond surface-level analysis.',
    'Construct a code dependency graph from AST analysis and use it to determine the impact radius of pull request changes.',
    'Combine graph-based impact retrieval with vector-based semantic search and LLM-powered reasoning to produce high-quality reviews.',
    'Provide a scalable, event-driven architecture suitable for real-world deployment using message queues and microservices.',
    'Support conversational codebase querying via a RAG-powered API endpoint.',
]
for idx, o in enumerate(objectives, 1):
    add_bullet(o)

add_spacer()

# ══════════════════════════════════════════════════════════════════════
#  4. BACKGROUND STUDY
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('4. Background Study', level=1)

bg_sections = [
    ('4.1 Abstract Syntax Trees (AST)',
     'An AST is a tree representation of the syntactic structure of source code. '
     'Each node in the tree corresponds to a construct in the source language (e.g., '
     'a function declaration, a variable assignment, a class definition). By parsing '
     'code into an AST, we can programmatically extract structured information such '
     'as function names, parameter signatures, line ranges, and call relationships '
     'without relying on fragile text-based pattern matching. In this project, the '
     'Babel parser is used to generate ASTs for JavaScript and TypeScript files, '
     'and Babel\u2019s traverse utility walks the tree to extract symbols (functions, '
     'classes, methods) and dependencies (function calls, imports).'),

    ('4.2 Retrieval-Augmented Generation (RAG)',
     'RAG is a paradigm that augments LLM prompts with externally retrieved '
     'context before generation. Instead of relying solely on the model\u2019s '
     'parametric memory (which can hallucinate), RAG retrieves relevant documents '
     'or code snippets from a knowledge base and injects them into the prompt. '
     'This grounds the model\u2019s output in factual, up-to-date information. Our '
     'system uses RAG twice: once for the code query endpoint (semantic search + '
     'answer generation) and once for PR reviews (graph-based impact retrieval + '
     'review generation).'),

    ('4.3 Vector Databases and Semantic Embeddings',
     'Semantic embeddings are dense numerical vectors that capture the meaning of '
     'text (or code). Similar code fragments produce vectors that are close '
     'together in the embedding space. A vector database like Pinecone stores '
     'these embeddings and enables efficient similarity search via approximate '
     'nearest neighbor algorithms. In this project, each code symbol (function, '
     'class, method) is embedded using the sentence-transformers/all-mpnet-base-v2 '
     'model (768-dimensional) and stored in Pinecone with rich metadata (file '
     'path, symbol name, type, line range, source code).'),

    ('4.4 Code Dependency Graphs',
     'A code dependency graph models relationships between code entities. Nodes '
     'represent symbols (functions, classes, methods), and edges represent '
     'dependencies (function calls, module imports). By constructing this graph, '
     'we can answer questions like \u201cWhich functions call function X?\u201d or \u201cIf '
     'function X changes, what else might break?\u201d This project stores the '
     'dependency graph in a PostgreSQL (Neon) database as two tables: symbols '
     '(nodes) and edges (directed dependencies).'),

    ('4.5 Large Language Models for Code Understanding',
     'LLMs trained on code (such as Google\u2019s Gemma family) can reason about '
     'programming logic, detect bugs, and generate natural language explanations '
     'of code behavior. When provided with sufficient context \u2014 the diff, the '
     'impacted downstream code, and clear instructions \u2014 these models can perform '
     'high-quality code review that approaches the reasoning of a senior engineer.'),

    ('4.6 Message Queues and Asynchronous Processing',
     'Message queues (such as BullMQ backed by Redis) enable decoupling of event '
     'producers from event consumers. In a webhook-driven system, incoming events '
     'can arrive in bursts and take variable time to process. By enqueuing events '
     'and processing them asynchronously via dedicated workers, the system achieves '
     'reliability (with retries and backoff), scalability (workers can be scaled '
     'independently), and responsiveness (webhook endpoints return immediately).'),
]

for title, text in bg_sections:
    add_heading_styled(title, level=2)
    add_body(text)

add_spacer()

# ══════════════════════════════════════════════════════════════════════
#  5. LITERATURE SURVEY
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('5. Literature Survey', level=1)

add_heading_styled('5.1 Review of Related Work', level=2)

papers = [
    ('[1]',
     'M. Tufano, C. Watson, G. Bavota, M. Di Penta, M. White, and D. Poshyvanyk, '
     '\u201cAn Empirical Study on Learning Bug-Fixing Patches in the Wild,\u201d in Proc. '
     'ACM/IEEE 40th Intl. Conf. on Software Engineering (ICSE), 2018, pp. 506-517.',
     'This work studied automated program repair by learning from historical '
     'bug-fixing commits. The approach treats bug fixing as a neural machine '
     'translation task (buggy code \u2192 fixed code).',
     'The system operates on isolated code fragments and does not consider '
     'inter-file dependencies or the broader impact of changes.'),

    ('[2]',
     'P. Lewis, E. Perez, A. Piktus, et al., \u201cRetrieval-Augmented Generation for '
     'Knowledge-Intensive NLP Tasks,\u201d in Advances in Neural Information Processing '
     'Systems (NeurIPS), 2020.',
     'This foundational paper introduced the RAG paradigm, demonstrating that '
     'combining a retrieval component with a generative model significantly improves '
     'factual accuracy on knowledge-intensive tasks.',
     'The RAG framework was designed for natural language documents, not source code. '
     'Code has structural properties (ASTs, scopes, types) that pure text retrieval '
     'does not exploit.'),

    ('[3]',
     'Y. Li, D. Choi, J. Chung, et al., \u201cCompetition-Level Code Generation with '
     'AlphaCode,\u201d Science, vol. 378, no. 6624, pp. 1092-1097, 2022.',
     'DeepMind\u2019s AlphaCode demonstrated that LLMs can generate competitive-level '
     'programming solutions when given problem descriptions and example test cases.',
     'The system generates code from scratch but does not review existing code or '
     'assess the impact of code changes on a live codebase.'),

    ('[4]',
     'S. Lu, D. Guo, S. Ren, et al., \u201cCodeBERT: A Pre-Trained Model for Programming '
     'and Natural Languages,\u201d in Proc. Findings of EMNLP 2020, pp. 1536-1547.',
     'CodeBERT is a bimodal pre-trained model for both programming and natural '
     'languages, achieving strong performance on code search and documentation '
     'generation tasks.',
     'CodeBERT provides embeddings and classification but lacks the generative review '
     'capability and graph-based impact analysis that a full code review system requires.'),

    ('[5]',
     'A. Svyatkovskiy, S. K. Deng, S. Fu, and N. Sundaresan, \u201cIntelliCode Compose: '
     'Code Generation Using Transformer,\u201d in Proc. ACM Joint European Software '
     'Engineering Conference and Symposium on the Foundations of Software Engineering '
     '(ESEC/FSE), 2020, pp. 1433-1443.',
     'Microsoft\u2019s IntelliCode uses GPT-based transformers for multi-token code '
     'completion within IDEs, demonstrating practical LLM deployment for developers.',
     'Focused on code completion rather than review. Does not analyze the impact of '
     'code changes on the broader repository or generate structured review feedback.'),

    ('[6]',
     'R. Li, L. B. Allal, Y. Zi, et al., \u201cStarCoder: May the Source Be with You,\u201d '
     'arXiv preprint arXiv:2305.06161, 2023.',
     'StarCoder is a 15B-parameter code-generation LLM trained on permissively '
     'licensed GitHub data, supporting 80+ languages with an 8K context window.',
     'While powerful for code generation and infilling, StarCoder does not incorporate '
     'repository-level context, dependency graphs, or diff-aware analysis for code review.'),

    ('[7]',
     'C. S. Xia and L. Zhang, \u201cAutomated Program Repair via Conversation-Driven LLMs,\u201d '
     'in Proc. ACM/IEEE 45th Intl. Conf. on Software Engineering (ICSE), 2023.',
     'This work uses conversational LLM interactions to iteratively refine program '
     'repair patches, achieving state-of-the-art results on standard benchmarks.',
     'Repair focus is on isolated bugs rather than holistic PR review. Does not '
     'construct or traverse dependency graphs to find integration-level defects.'),

    ('[8]',
     'J. Austin, A. Odena, M. Nye, et al., \u201cProgram Synthesis with Large Language '
     'Models,\u201d arXiv preprint arXiv:2108.07732, 2021.',
     'Google\u2019s study on using LLMs for program synthesis from docstrings, establishing '
     'the HumanEval benchmark for evaluating code-generation quality.',
     'Evaluation is limited to isolated function synthesis. Does not address the '
     'challenge of reviewing code changes within the context of a full repository '
     'and its dependency structure.'),
]

for ref, citation, summary, gap in papers:
    # Reference + Citation in a lightly shaded box
    ref_tbl = doc.add_table(rows=1, cols=1)
    ref_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    ref_cell = ref_tbl.rows[0].cells[0]
    ref_cell.text = ''
    set_cell_shading(ref_cell, ROW_ALT)
    set_cell_margins(ref_cell, top=80, bottom=80, left=150, right=150)
    rp = ref_cell.paragraphs[0]
    run_ref = rp.add_run(ref + '  ')
    run_ref.bold = True
    run_ref.font.size = Pt(11)
    run_ref.font.name = 'Calibri'
    run_ref.font.color.rgb = ACCENT
    run_cit = rp.add_run(citation)
    run_cit.italic = True
    run_cit.font.size = Pt(10)
    run_cit.font.name = 'Calibri'
    run_cit.font.color.rgb = BODY_COLOR

    p2 = doc.add_paragraph()
    p2.paragraph_format.left_indent = Inches(0.3)
    p2.paragraph_format.space_before = Pt(4)
    run_s = p2.add_run('\u25B6  Summary: ')
    run_s.bold = True
    run_s.font.size = Pt(11)
    run_s.font.name = 'Calibri'
    run_s.font.color.rgb = NAVY
    run_st = p2.add_run(summary)
    run_st.font.size = Pt(11)
    run_st.font.name = 'Calibri'
    run_st.font.color.rgb = BODY_COLOR

    p3 = doc.add_paragraph()
    p3.paragraph_format.left_indent = Inches(0.3)
    p3.paragraph_format.space_after = Pt(10)
    run_g = p3.add_run('\u26A0  Research Gap: ')
    run_g.bold = True
    run_g.font.color.rgb = GAP_RED
    run_g.font.size = Pt(11)
    run_g.font.name = 'Calibri'
    run_gt = p3.add_run(gap)
    run_gt.font.size = Pt(11)
    run_gt.font.name = 'Calibri'
    run_gt.font.color.rgb = BODY_COLOR

add_heading_styled('5.2 Summary of Research Gaps', level=2)
add_body(
    'The literature reveals that while significant progress has been made in '
    'LLM-based code generation, completion, and repair, there remains a notable '
    'gap in systems that:'
)
gap_summary = [
    'Combine structural code analysis (AST parsing, dependency graphs) with semantic retrieval (vector embeddings) and LLM reasoning for code review.',
    'Perform diff-aware impact analysis \u2014 mapping changed lines to affected symbols and their downstream dependents \u2014 before invoking the LLM.',
    'Operate as integrated GitHub-native applications with production-grade architecture (webhooks, message queues, microservices).',
]
for g in gap_summary:
    add_bullet(g)
add_colored_box('\u2714  This project addresses all three gaps.', ACCENT_LIGHT, NAVY)

add_section_divider()

# ══════════════════════════════════════════════════════════════════════
#  6. PROPOSED SYSTEM
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('6. Proposed System', level=1)

add_heading_styled('6.1 Core Contribution', level=2)
add_body(
    'This project proposes a novel Graph-Augmented RAG system for automated code '
    'review that differs from existing solutions in three fundamental ways:'
)

contributions = [
    ('Symbol-Level Embeddings Instead of Text Chunks',
     'Conventional RAG systems split documents into fixed-size text chunks '
     '(e.g., 500 tokens). This leads to arbitrary boundaries that split '
     'functions in half or merge unrelated code. Our system uses AST '
     'parsing to decompose code into its natural structural units \u2014 '
     'functions, classes, and methods \u2014 and embeds each unit as a '
     'standalone vector. This preserves semantic coherence and enables '
     'precise retrieval.'),
    ('Diff-to-Graph Impact Retrieval',
     'Rather than searching for \u201crelated code\u201d using generic semantic '
     'similarity, our system follows a deterministic pipeline: '
     'Diff Text \u2192 Parse Changed Line Ranges \u2192 Map to AST Symbols (Overlap '
     'Detection) \u2192 Traverse Dependency Graph (Expand Impact) \u2192 Fetch '
     'Dependent Code from Vector Store. '
     'This ensures the LLM receives not just the changes, but the exact '
     'downstream code that depends on those changes \u2014 enabling detection '
     'of breaking changes, signature mismatches, and logical regressions.'),
    ('Dual-Database Architecture for Graph + Semantic Search',
     'The system uses PostgreSQL (Neon) to store the dependency graph '
     '(symbols and edges) for fast SQL-based traversal, and Pinecone to '
     'store semantic embeddings for efficient similarity search. This '
     'separation allows each database to be optimized for its specific '
     'access pattern.'),
]

for title, desc in contributions:
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.3)
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(2)
    run_t = p.add_run('\u25AA  ' + title)
    run_t.bold = True
    run_t.font.size = Pt(11)
    run_t.font.name = 'Calibri'
    run_t.font.color.rgb = ACCENT
    p2 = doc.add_paragraph()
    p2.paragraph_format.left_indent = Inches(0.5)
    p2.paragraph_format.space_after = Pt(4)
    run_d = p2.add_run(desc)
    run_d.font.size = Pt(11)
    run_d.font.name = 'Calibri'
    run_d.font.color.rgb = BODY_COLOR

add_heading_styled('6.2 Workflow Overview', level=2)
add_body('The system operates in three distinct modes plus a bonus mode:')

modes = [
    ('Mode 1 \u2014 Repository Ingestion', 'Triggered by GitHub App installation', [
        'Fetch all JavaScript/TypeScript files from the repository via GitHub API tree endpoint.',
        'Parse each file into an AST using Babel.',
        'Extract symbols (functions, classes, methods, arrow functions) with their line ranges and source code.',
        'Extract dependencies (function calls, imports/requires) with caller-callee relationships.',
        'Store symbols and edges in Neon PostgreSQL (code dependency graph).',
        'Generate 768-dimensional embeddings for each symbol using HuggingFace all-mpnet-base-v2.',
        'Upload embeddings with metadata to Pinecone vector database.',
    ]),
    ('Mode 2 \u2014 Incremental Update', 'Triggered by push to default branch', [
        'Identify modified and deleted files from the push event.',
        'For deleted files: remove corresponding graph nodes and vectors.',
        'For modified files: delete old data, re-ingest using the full three-phase pipeline (delete-then-insert for consistency).',
    ]),
    ('Mode 3 \u2014 Pull Request Review', 'Triggered by PR open/reopen/sync', [
        'Fetch the raw diff from GitHub API.',
        'Parse the diff to extract changed file paths and line ranges (using OLD file coordinates to match the pre-PR database state).',
        'Query the symbol table to find symbols overlapping the changed ranges (overlap formula: SymbolStart \u2264 RangeEnd AND SymbolEnd \u2265 RangeStart).',
        'Expand the impact by traversing outgoing edges in the dependency graph (find all symbols that the changed symbols call).',
        'Fetch source code of all impacted symbols from Pinecone.',
        'Send the diff + impacted context to the LLM with a structured prompt requesting bug detection, impact analysis, and categorized review feedback (Critical / Suggestion / Commendation).',
        'Post the generated review as a comment on the GitHub PR.',
    ]),
    ('Bonus Mode \u2014 Codebase Querying', 'Triggered via API endpoint', [
        'Accept a natural language query and repository identifier.',
        'Embed the query and perform semantic search against Pinecone.',
        'Retrieve top-k matching code symbols with their source code.',
        'Generate a natural language answer using the LLM grounded in the retrieved context.',
    ]),
]

for mode_title, trigger, steps in modes:
    p = doc.add_paragraph()
    run_mt = p.add_run(mode_title)
    run_mt.bold = True
    run_mt.font.size = Pt(11)
    run_mt.font.name = 'Calibri'
    run_tr = p.add_run(f' ({trigger})')
    run_tr.italic = True
    run_tr.font.size = Pt(11)
    run_tr.font.name = 'Calibri'
    for step in steps:
        add_numbered(step)

add_heading_styled('6.3 Novelty Highlights', level=2)
novelties = [
    'Three-Phase AST-Driven RAG Pipeline: Parse \u2192 Graph \u2192 Embed, ensuring every vector in the database corresponds to a meaningful code unit rather than an arbitrary text chunk.',
    'Overlap-Based Diff-to-Symbol Mapping: Uses mathematical overlap detection between diff line ranges and stored symbol line ranges to precisely identify affected code entities.',
    'Dependency Graph Expansion: After identifying directly affected symbols, the system follows outgoing call edges to find transitively impacted code \u2014 catching integration-level issues.',
    'Old-File Coordinate Alignment: Diffs report changes using old-file line numbers. The system correctly maps these against the pre-PR database state, avoiding coordinate misalignment bugs.',
    'Cascading Delete Safety: Leverages PostgreSQL foreign key constraints with CASCADE to ensure that deleting a symbol automatically removes all its associated edges, preventing orphaned graph data.',
    'Symbol Stack for Nested Scope: The AST traversal uses a stack-based approach to correctly handle nested functions, ensuring that inner function calls are attributed to the correct enclosing symbol.',
    'Dual-Temperature LLM Strategy: Uses temperature 0.2 for factual Q&A (moderate creativity for explanation) and temperature 0.1 for PR review (strict logical reasoning, minimal hallucination).',
    'Production-Grade Asynchronous Architecture: BullMQ workers with configurable concurrency, exponential backoff retry, and job deduplication prevent duplicate processing of GitHub webhook retries.',
]
for n in novelties:
    add_bullet(n)

add_spacer()

# ══════════════════════════════════════════════════════════════════════
#  7. SYSTEM ARCHITECTURE
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('7. System Architecture', level=1)

add_heading_styled('7.1 High-Level Architecture Diagram', level=2)

add_body(
    'The following diagram illustrates the complete system architecture, '
    'showing the flow of data from GitHub through the webhook and RAG services '
    'to the external databases and AI models.',
    italic=True
)

# Architecture as a structured table representation
arch_layers = [
    ['GITHUB PLATFORM', 'Pull Requests, Push Events, App Install Events'],
    ['\u2193 Webhook (HMAC SHA-256 verified)', ''],
    ['WEBHOOK SERVICE (Node.js / Express)', 'Event Router: pull_request \u2192 Review Queue | push \u2192 Update Queue | installation \u2192 Ingestion Queue'],
    ['\u2193 Redis (Upstash TLS) / BullMQ', ''],
    ['RAG SERVICE (Node.js / Express)', 'Workers: Ingestion (full repo parse), Update (incremental), Review (PR analysis, concurrency=2)'],
    ['Service Layer', 'embeddingService, graphService, ingestionService, retrievalService, updationService, llmService'],
    ['HTTP API', 'POST /query (API Key auth) \u2192 Semantic Codebase Q&A'],
]

arch_table = doc.add_table(rows=len(arch_layers), cols=2)
arch_table.style = 'Table Grid'
arch_table.alignment = WD_TABLE_ALIGNMENT.CENTER
for i, (component, detail) in enumerate(arch_layers):
    c1 = arch_table.rows[i].cells[0]
    c1.text = ''
    r1 = c1.paragraphs[0].add_run(component)
    r1.bold = True
    r1.font.size = Pt(10)
    r1.font.name = 'Calibri'
    if i in (0, 2, 4):
        set_cell_shading(c1, '1B3A5C')
        r1.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    elif i in (1, 3):
        set_cell_shading(c1, 'D5E8D4')
    else:
        set_cell_shading(c1, 'EDF2F7')

    c2 = arch_table.rows[i].cells[1]
    c2.text = ''
    r2 = c2.paragraphs[0].add_run(detail)
    r2.font.size = Pt(10)
    r2.font.name = 'Calibri'
    if i in (0, 2, 4):
        set_cell_shading(c2, '1B3A5C')
        r2.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    elif i in (1, 3):
        set_cell_shading(c2, 'D5E8D4')
    else:
        set_cell_shading(c2, 'EDF2F7')

doc.add_paragraph()

# External services table
add_body('External Services:', bold=True)
ext_headers = ['Service', 'Technology', 'Purpose']
ext_rows = [
    ['Relational Database', 'Neon PostgreSQL (Serverless)', 'Code dependency graph (symbols + edges), user/repo metadata'],
    ['Vector Database', 'Pinecone (768-dim, cosine)', 'Semantic code embeddings with rich metadata'],
    ['LLM Provider', 'Google GenAI (Gemma 3 12B IT)', 'PR review generation, codebase Q&A'],
    ['Embedding Model', 'HuggingFace all-mpnet-base-v2', '768-dimensional semantic code embeddings'],
    ['Message Broker', 'Redis via Upstash (TLS)', 'BullMQ job queue backend'],
]
add_table(ext_headers, ext_rows)

add_heading_styled('7.2 Module Descriptions', level=2)

modules = [
    ('Module 1: Webhook Service',
     'Receives GitHub webhook events over HTTPS. Verifies webhook signature using HMAC SHA-256 with a shared secret. Routes events to appropriate BullMQ queues based on event type. Stateless \u2014 does no processing, only enqueues.'),
    ('Module 2: Ingestion Worker',
     'Authenticates as the GitHub App using the installation ID. Fetches the full repository file tree via the GitHub Trees API. Filters for JavaScript/TypeScript files (.js, .jsx, .ts, .tsx, .mjs, .cjs). Downloads file contents as base64-decoded blobs. Invokes the embedding service for AST parsing and vectorization.'),
    ('Module 3: Embedding Service (AST Pipeline)',
     'Parses code into AST using @babel/parser with JSX and TypeScript plugins. Traverses AST to extract symbols (FunctionDeclaration, ClassDeclaration, ClassMethod, ArrowFunctionExpression, FunctionExpression). Extracts dependencies (CallExpression for function calls, ImportDeclaration/require for module imports). Uses a symbol stack data structure for correct nested scope handling. Generates 768-dim embeddings via HuggingFace Inference API. Uploads vectors to Pinecone in batches of 50.'),
    ('Module 4: Graph Service',
     'Provides CRUD operations on the symbol-edge graph in PostgreSQL. Two-phase insertion: symbols first, then edges (prevents orphaned edges). Cascading deletes via foreign key constraints. Conflict-safe inserts with ON CONFLICT DO NOTHING.'),
    ('Module 5: Retrieval Service (Impact Analysis Engine)',
     'Parses Git diffs using the parse-diff library. Maps diff chunks to old-file line coordinates. Queries symbols table with overlap formula to find affected symbols. Expands impact via edge traversal (follows outgoing \u201ccalls\u201d edges). Fetches source code of impacted symbols from Pinecone metadata.'),
    ('Module 6: LLM Service',
     'Formats impact context into structured prompt sections. Manages two prompt templates: Q&A mode and PR Review mode. PR Review prompt instructs the LLM to compare the diff against impacted downstream code and categorize findings. Controls generation parameters (temperature, topP, topK).'),
    ('Module 7: Update Service',
     'Handles incremental updates on push to the default branch. Delete-then-insert strategy ensures data consistency. Processes both modified files (re-ingest) and removed files (clean up).'),
]

for title, desc in modules:
    p = doc.add_paragraph()
    run_t = p.add_run(title)
    run_t.bold = True
    run_t.font.size = Pt(11)
    run_t.font.name = 'Calibri'
    add_body(desc, indent=1)

add_spacer()

# ══════════════════════════════════════════════════════════════════════
#  8. PROTOCOL STACK
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('8. Protocol Stack', level=1)

add_body(
    'The system\u2019s communication is organized into the following layered '
    'protocol stack, described from the application layer down:'
)

protocol_headers = ['Layer', 'Name', 'Components']
protocol_rows = [
    ['Layer 7', 'Application Layer',
     'GitHub Webhook Events (JSON/HTTPS); REST API Endpoints (POST /query, POST /api/webhook); '
     'GitHub REST API v3 (Octokit SDK); Google GenAI API; HuggingFace Inference API; Pinecone REST API'],
    ['Layer 6', 'Authentication & Authorization',
     'GitHub App Auth (JWT + Installation Tokens); Webhook Signature Verification (HMAC SHA-256); '
     'API Key Auth (X-API-Key header); Pinecone API Key; Google GenAI API Key'],
    ['Layer 5', 'Message Queue Layer',
     'BullMQ Job Queues (ingestion, update, review); JSON serialization; '
     'Exponential backoff (5s base, 3 attempts); Concurrency control (review x2, others x1); '
     'Job deduplication via unique IDs'],
    ['Layer 4', 'Data Access Layer',
     'Drizzle ORM (type-safe SQL for PostgreSQL); Connection pooling via pg.Pool with SSL; '
     'Pinecone SDK (vector operations + metadata filtering); ioredis (TLS-encrypted)'],
    ['Layer 3', 'Data Storage Layer',
     'PostgreSQL/Neon: users, installations, repositories, symbols, edges (B-tree indexes, unique constraints); '
     'Pinecone: 768-dim vectors, cosine similarity; Redis/Upstash: job queue persistence'],
    ['Layer 2', 'Transport Layer',
     'HTTPS/TLS 1.2+ for all external APIs; TLS-encrypted Redis; SSL-required PostgreSQL; '
     'TCP via Node.js HTTP agent and pg.Pool'],
    ['Layer 1', 'Network / Infrastructure',
     'Node.js runtime (Express HTTP servers); Microservice deployment (webhook + RAG services); '
     'Cloud-hosted databases (Neon, Pinecone, Upstash); GitHub Cloud (webhook delivery)'],
]
add_table(protocol_headers, protocol_rows)

add_spacer()

# ══════════════════════════════════════════════════════════════════════
#  9. TESTBED / EXPERIMENTAL SETUP
# ══════════════════════════════════════════════════════════════════════

add_heading_styled('9. Testbed / Experimental Setup', level=1)

add_heading_styled('9.1 Development Environment', level=2)
dev_env = [
    'Runtime: Node.js (v18+)',
    'Language: JavaScript (ES Modules + CommonJS interop)',
    'Package Manager: npm',
    'IDE: Visual Studio Code',
]
for d in dev_env:
    add_bullet(d)

add_heading_styled('9.2 Cloud Services and Infrastructure', level=2)

cloud_headers = ['Service', 'Provider / Technology', 'Details']
cloud_rows = [
    ['Database', 'Neon PostgreSQL (serverless)', 'Stores dependency graph, user data, installation metadata, repository records. ORM: Drizzle with drizzle-kit migrations.'],
    ['Vector Database', 'Pinecone (managed, serverless)', 'Index: code-review-index; Dimensions: 768; Metric: Cosine. Stores semantic embeddings of code symbols.'],
    ['Message Broker', 'Redis via Upstash (TLS)', 'Backs BullMQ job queues: ingestion-queue, update-queue, review-queue.'],
    ['LLM Provider', 'Google GenAI', 'Model: gemma-3-12b-it (12B params, instruction-tuned, open-weights). Generates PR reviews and Q&A answers.'],
    ['Embedding Model', 'HuggingFace Inference API', 'Model: sentence-transformers/all-mpnet-base-v2; Dimension: 768.'],
    ['Version Control', 'GitHub', 'GitHub App (scoped permissions per installation). Events: pull_request, push, installation. Auth: JWT + installation tokens.'],
]
add_table(cloud_headers, cloud_rows)

add_heading_styled('9.3 Software Libraries and Frameworks', level=2)

lib_headers = ['Category', 'Library', 'Version', 'Purpose']
lib_rows = [
    ['HTTP Server', 'Express', '5.2.1', 'REST API framework'],
    ['GitHub Integration', '@octokit/app', '13.1.8', 'GitHub App SDK'],
    ['GitHub API Client', 'octokit', '5.0.5', 'REST API calls'],
    ['AST Parser', '@babel/parser', '7.29.0', 'JS/TS AST generation'],
    ['AST Traversal', '@babel/traverse', '7.29.0', 'Symbol extraction'],
    ['LLM Client', '@google/genai', '1.40.0', 'Google GenAI SDK'],
    ['LangChain Core', '@langchain/core', '1.1.19', 'RAG framework'],
    ['LangChain Embeddings', '@langchain/community', '1.1.11', 'HuggingFace embeddings'],
    ['Text Splitting', '@langchain/textsplitters', '1.0.1', 'Text chunking utilities'],
    ['HuggingFace Client', '@huggingface/inference', '4.13.11', 'Embedding API client'],
    ['Vector DB Client', '@pinecone-database/pinecone', '6.1.0', 'Pinecone SDK'],
    ['ORM', 'drizzle-orm', '0.45.1', 'Type-safe SQL ORM'],
    ['Schema Migrations', 'drizzle-kit', '0.31.9', 'DB migration tooling'],
    ['PostgreSQL Driver', 'pg', '8.18.0', 'Native PG client'],
    ['Job Queue', 'bullmq', '5.69.3', 'Redis-backed job queue'],
    ['Redis Client', 'ioredis', '5.9.3', 'Redis protocol client'],
    ['Diff Parser', 'parse-diff', '0.11.1', 'Git diff parsing'],
    ['Env Configuration', 'dotenv', '16.6.1', 'Environment variables'],
]
add_table(lib_headers, lib_rows)

add_heading_styled('9.4 Database Schema Specification', level=2)

schema_headers = ['Table', 'Role', 'Key Fields', 'Constraints / Indexes']
schema_rows = [
    ['users', 'User accounts (synced from Clerk)', 'clerkId, email, fullName, avatarUrl, githubId, tier, credits', 'Unique: clerkId, githubId'],
    ['installations', 'GitHub App installations', 'userId (FK\u2192users), githubInstallationId, accountLogin, accountType', 'Unique: githubInstallationId; CASCADE on user delete'],
    ['repositories', 'Indexed repositories', 'installationId (FK\u2192installations), githubRepoId, name, fullName, url, private, isIndexed', 'Unique: (installationId, githubRepoId); CASCADE'],
    ['symbols', 'Graph Nodes (AST symbols)', 'repositoryId (FK\u2192repositories), filePath, symbolName, symbolType, startLine, endLine', 'Unique: (repoId, filePath, symbolName, startLine); Index: idx_symbols_repo; CASCADE'],
    ['edges', 'Graph Edges (dependencies)', 'repositoryId (FK\u2192repositories), fromSymbolId (FK\u2192symbols), toSymbolId (FK\u2192symbols), edgeType', 'Unique: (repoId, from, to, type); Indexes: idx_edges_repo, idx_edges_from, idx_edges_to; CASCADE'],
]
add_table(schema_headers, schema_rows)

add_heading_styled('9.5 Testing Infrastructure', level=2)
test_items = [
    'Mock Payloads (mockPayload.js): Simulates full repository structure (utils.js, service.js, controller.js) for ingestion testing.',
    'Mock Update Payloads (mockUpdatePayload.js): Simulates push events with modified and deleted files.',
    'Test Server (testServer.js): Provides standalone endpoints for isolated testing of ingestion, query, and impact analysis pipelines.',
    'SDK Smoke Tests (sdkTest.js): Verifies Pinecone vector database connectivity and operations.',
]
for t in test_items:
    add_bullet(t)

add_heading_styled('9.6 Queue Configuration Details', level=2)

queue_headers = ['Queue', 'Concurrency', 'Retry Attempts', 'Backoff Strategy', 'Job Removal']
queue_rows = [
    ['review-queue', '2 (parallel PR processing)', '3', 'Exponential (base: 5000ms)', 'Completed jobs auto-removed'],
    ['ingestion-queue', '1 (sequential)', 'Default', 'Default', 'Completed jobs auto-removed'],
    ['update-queue', '1 (sequential)', 'Default', 'Default', 'Completed jobs auto-removed'],
]
add_table(queue_headers, queue_rows)

add_heading_styled('9.7 Security Measures', level=2)
security = [
    'Webhook Signature Verification: HMAC SHA-256 with shared secret ensures only GitHub can trigger processing.',
    'API Key Authentication: X-API-Key header required for the /query endpoint prevents unauthorized access.',
    'TLS Encryption: All database and cache connections (Neon, Upstash) use TLS for data in transit.',
    'GitHub App Scoping: Permissions are scoped per installation, following the principle of least privilege.',
    'Environment Variable Isolation: All secrets (API keys, database URLs, private keys) stored in .env files, never hardcoded.',
    'Cascading Deletes: Foreign key constraints with CASCADE prevent orphaned data across the graph.',
]
for s in security:
    add_bullet(s)

# ── Final footer ───────────────────────────────────────────────────────
doc.add_page_break()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run('END OF SUBMISSION DOCUMENT')
run.bold = True
run.font.size = Pt(14)
run.font.color.rgb = RGBColor(0x1B, 0x3A, 0x5C)
run.font.name = 'Calibri'

add_spacer()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run('Prepared for academic evaluation.\nAll content is original and based on the actual implemented system.')
run.italic = True
run.font.size = Pt(11)
run.font.color.rgb = RGBColor(0x77, 0x77, 0x77)
run.font.name = 'Calibri'

# ── Save ───────────────────────────────────────────────────────────────
output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'Project_Submission_Document.docx')
doc.save(output_path)
print(f"Document saved to: {output_path}")
