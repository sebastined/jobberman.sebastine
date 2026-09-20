// Generates a tailored one-off CV PDF for one job posting: same real
// experience/skills as the master CV, reordered to lead with what's
// relevant to that posting, plus a short tailored summary paragraph.
// Never invents content - only reorders and re-emphasizes what's here.
//
// Usage: node generate.mjs <config.json> <outPath.pdf>
// config.json shape: { postingLabel, summary, roleOrder: [role keys below] }
//
// Requires pdf-lib (npm install pdf-lib in this folder first).

import { writeFile, readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const MARGIN_L = 50, MARGIN_R = 545, PAGE_W = 595.32, PAGE_H = 841.92;
const CONTENT_W = MARGIN_R - MARGIN_L;

// Source of truth: C:\work\sebastine.com\cv.sebastine\Sebastine_Nnanemere_MASTER_CV.pdf
// Keep this in sync by hand if the master CV changes (new role, new cert, etc.)
export const ROLES = {
  // OGA SABI Ltd (Jun 2024-) and the independent GRC Advisor work (2024-)
  // were consolidated and rebranded under Sebastine's own business, Vigilsec,
  // as of Jan 2025 - same continuous work, one entry, per his 2026-09-20
  // confirmation. Do not re-split these.
  vigilsec: {
    header: 'Senior Cloud Security Engineer & GRC Advisor | Vigilsec, Messina, Italy (vigilsec.it)',
    dates: 'Jan 2025 \u2013 Present',
    bullets: [
      'Triage security findings from Security Hub, GuardDuty, and Config, correlating data to reduce false positives and driving remediation directly with engineering teams.',
      'Embed security requirements and controls into CI/CD pipelines via reusable Terraform modules and policy gates, enforcing secure-by-default standards at build and deploy time.',
      'Automate compliance monitoring and audit evidence generation (Python/Bash, n8n) for SOC 2 and ISO 27001, including recurring metrics dashboards and executive-ready reporting.',
      'Act as technical advisor and point of contact between engineering, compliance, and business stakeholders, translating regulatory requirements into practical engineering guidance.',
      'Maintain documentation and runbooks functioning as a living knowledge base, reducing repeat escalations for recurring technical and compliance questions.',
      'Deliver independent GRC advisory engagements for startups and small businesses, including ISO 27001 gap assessments, using ciso.ikenga.ng \u2014 a self-built platform combining policy generation, risk assessment, and compliance tracking for non-technical stakeholders.',
      'Own a queue of incoming client requests end-to-end across multiple accounts simultaneously, managing competing deadlines and varying levels of technical sophistication, and knowing precisely when to loop in additional expertise rather than guessing.',
    ],
  },
  elate: {
    header: 'Solutions Engineer \u2014 Cloud Security & IAM | Elate LLC (elate.xyz)',
    dates: '2024',
    bullets: [
      'Designed secure-by-default cloud architectures across GCP and AWS, applying Zero Trust principles to new product designs.',
      'Conducted security posture assessments aligned to GDPR and PCI DSS for enterprise clients, delivering remediation guidance to both technical and non-technical audiences.',
    ],
  },
  soft: {
    header: 'Cloud Security Specialist | Soft Solutions S.R.L (softsolutions.it)',
    dates: '2023 \u2013 2024',
    bullets: [
      'Built automated vulnerability scanning pipelines integrated into a centralized security metrics dashboard, supporting vulnerability management and remediation across products.',
      'Led ISO 27001 control implementation and GDPR compliance work \u2014 data flow mapping, DPIAs, and risk assessments \u2014 partnering directly with legal and engineering stakeholders.',
      'Managed control monitoring and remediation tracking across multiple stakeholders, maintaining accurate compliance evidence under deadline pressure.',
    ],
  },
  springboard: {
    header: 'Cloud Security Mentor & SecOps Practitioner | Springboard (springboard.com)',
    dates: '2023 \u2013 2025',
    bullets: [
      'Trained and mentored 100+ engineers on cloud security architecture, Kubernetes security, and CI/CD security integration in an international, English-speaking cohort.',
      'Built structured, repeatable training materials and support workflows serving learners across a range of technical backgrounds.',
    ],
  },
  hardcore: {
    header: 'Security Engineer \u2014 Infrastructure & Cloud | Hardcore Biometric Systems (hardcorebiometric.com)',
    dates: '2020 \u2013 2023',
    bullets: [
      'Hardened Kubernetes clusters (EKS): RBAC, Network Policies, Pod Security Admission, and image scanning in CI/CD \u2014 ensuring secure-by-default container deployments at scale.',
      'Deployed Zero Trust Architecture across cloud and on-prem environments, reducing unauthorized access by 40%.',
      'Reduced critical vulnerability remediation time by 40% through risk-based prioritization and automated patch workflows.',
      'Automated compliance enforcement through AWS Config policies, improving adherence by 30% and generating audit-ready evidence.',
    ],
  },
  rewired: {
    header: 'IT Security Engineer | Rewired (rewired.ng)',
    dates: '2017 \u2013 2020',
    bullets: [
      'Implemented network segmentation and endpoint hardening across distributed infrastructure, reducing breach incidents by 50%.',
      'Designed firewall rule automation and access controls enforcing security baselines consistently across sites.',
    ],
  },
};

export const PLATFORMS = [
  'ciso.ikenga.ng \u2014 GRC platform for non-technical stakeholders combining policy generation, risk assessments, and compliance tracking; used as a live differentiator in GRC advisory engagements and directly analogous to vendor security questionnaire and Trust Center workflows.',
  'Ikenga Academy (merch.ikenga.ng) \u2014 Full-stack LMS designed and operated independently, delivering free English language and cybersecurity training to asylum seekers across Italy.',
  'Ofonet \u2014 Container security and vulnerability assessment tool scanning images within CI/CD pipelines (Kubernetes, Docker) before deployment.',
  'IP-Dibia \u2014 IP intelligence and threat enrichment engine automating IOC correlation for SIEM/alert workflows.',
  'Ikenga \u2014 Lightweight IP threat triage utility reducing manual investigation time during incident analysis.',
  'Self-hosted automation stack \u2014 n8n running on Oracle Cloud (ARM) powering personal and professional workflow automation, including a self-built media pipeline (streambox) integrating Telegram, MEGA, Cloudflare R2, and FFmpeg.',
];

// Keep in sync with candidate-profile.md's certification status.
export const CERTIFICATIONS = [
  'AWS Certified Solutions Architect \u2013 Associate',
  '(ISC)\u00b2 Certified in Cybersecurity (CC)',
  'CompTIA Security+',
  'Microsoft Azure Security Fundamentals',
  'Fortinet NSE 1\u20133 (Zero Trust Architecture)',
  'IELTS 7.5 / UKVI 7.5',
  'AWS Certified Security \u2013 Specialty (in progress \u2014 scored 709/1000, retake scheduled)',
];

export const COMPETENCIES = [
  ['Incident Response & Detection:', ' Alert triage and correlation (Security Hub, GuardDuty, Config), threat hunting, forensics support, playbook design, escalation workflows, IOC correlation'],
  ['DevSecOps & CI/CD Security:', ' GitHub Actions, GitLab CI, Jenkins, ArgoCD \u2014 shift-left security, container image scanning, policy-as-code deployment gates'],
  ['Container & Kubernetes Security:', ' EKS hardening, RBAC, Network Policies, Pod Security Admission, OPA/Gatekeeper, image scanning in CI/CD'],
  ['Automation & IaC:', ' Terraform, Ansible, Python and JavaScript/Bash scripting, n8n workflow automation (self-hosted on Oracle Cloud)'],
  ['GRC & Compliance:', ' SOC 2, ISO/IEC 27001, GDPR, PCI DSS, NIST \u2014 control implementation, gap assessments, audit evidence generation, policy-to-control mapping'],
  ['Vendor & Third-Party Risk:', ' Security questionnaire response (SIG/CAIQ-adjacent), vendor posture assessment, client-facing GRC advisory'],
  ['Systems & Networking:', ' Linux and Windows administration, network segmentation, endpoint hardening, firewall rule automation'],
  ['Training & Enablement:', ' Technical training design and delivery, mentoring, documentation and knowledge-base ownership, runbooks'],
];

function wrapText(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export async function generate(config, outPath) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const bold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 50;

  function newPageIfNeeded(needed) {
    if (y - needed < 40) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - 50;
    }
  }

  function drawParagraph(text, font, size, lineHeight, opts) {
    opts = opts || {};
    const x = opts.x || MARGIN_L;
    const maxWidth = opts.maxWidth || CONTENT_W;
    const lines = wrapText(text, font, size, maxWidth);
    for (const line of lines) {
      newPageIfNeeded(lineHeight);
      page.drawText(line, { x, y, size, font, color: rgb(0, 0, 0) });
      y -= lineHeight;
    }
  }

  function drawBullet(text, font, size, lineHeight) {
    const bulletX = MARGIN_L + 12;
    const textX = MARGIN_L + 24;
    const maxWidth = MARGIN_R - textX;
    const lines = wrapText(text, font, size, maxWidth);
    lines.forEach((line, i) => {
      newPageIfNeeded(lineHeight);
      if (i === 0) page.drawText('\u2022', { x: bulletX, y, size, font, color: rgb(0, 0, 0) });
      page.drawText(line, { x: textX, y, size, font, color: rgb(0, 0, 0) });
      y -= lineHeight;
    });
  }

  function drawSectionHeader(text) {
    newPageIfNeeded(26);
    y -= 6;
    page.drawText(text, { x: MARGIN_L, y, size: 12.5, font: bold, color: rgb(0, 0, 0) });
    y -= 4;
    page.drawLine({ start: { x: MARGIN_L, y }, end: { x: MARGIN_R, y }, thickness: 0.75, color: rgb(0, 0, 0) });
    y -= 14;
  }

  page.drawText('SEBASTINE NNANEMERE', { x: MARGIN_L, y, size: 17, font: bold });
  y -= 20;
  page.drawText('Senior Cloud Security Engineer \u00b7 DevSecOps, GRC, Incident Response & IT Operations', { x: MARGIN_L, y, size: 10.5, font: italic });
  y -= 15;
  page.drawText('+39 352 064 6565  |  iam@sebastine.com  |  Sicily, Italy \u2014 Full Remote across Europe  |  github.com/sebastined', { x: MARGIN_L, y, size: 9.5, font: regular });
  y -= 8;
  page.drawLine({ start: { x: MARGIN_L, y }, end: { x: MARGIN_R, y }, thickness: 1, color: rgb(0, 0, 0) });
  y -= 16;

  drawSectionHeader('PROFESSIONAL SUMMARY');
  drawParagraph('Tailored for: ' + config.postingLabel, italic, 9, 12);
  y -= 4;
  drawParagraph(config.summary, regular, 10, 13);
  y -= 8;

  drawSectionHeader('PROFESSIONAL EXPERIENCE');
  for (const roleKey of config.roleOrder) {
    const role = ROLES[roleKey];
    newPageIfNeeded(28);
    const headerWidth = bold.widthOfTextAtSize(role.header, 10.5);
    const datesWidth = italic.widthOfTextAtSize(role.dates, 10);
    page.drawText(role.header, { x: MARGIN_L, y, size: 10.5, font: bold });
    if (headerWidth + 10 + datesWidth <= CONTENT_W) {
      // Fits on one line: dates right-aligned beside the header.
      page.drawText(role.dates, { x: MARGIN_R - datesWidth, y, size: 10, font: italic });
      y -= 14;
    } else {
      // Header (with its company-domain suffix) is too long to share the
      // line with the dates - drop the dates to their own right-aligned line.
      y -= 13;
      page.drawText(role.dates, { x: MARGIN_R - datesWidth, y, size: 10, font: italic });
      y -= 14;
    }
    for (const bullet of role.bullets) drawBullet(bullet, regular, 9.5, 12.5);
    y -= 6;
  }

  drawSectionHeader('PLATFORMS & SECURITY TOOLS BUILT');
  for (const item of PLATFORMS) drawBullet(item, regular, 9.5, 12.5);
  y -= 8;

  drawSectionHeader('CERTIFICATIONS');
  for (const item of CERTIFICATIONS) drawBullet(item, regular, 9.5, 12.5);
  y -= 8;

  drawSectionHeader('CORE COMPETENCIES');
  for (const [label, rest] of COMPETENCIES) {
    newPageIfNeeded(13);
    const bulletX = MARGIN_L + 12, textX = MARGIN_L + 24, maxWidth = MARGIN_R - textX;
    const labelWidth = bold.widthOfTextAtSize(label, 9.5);
    page.drawText('\u2022', { x: bulletX, y, size: 9.5, font: regular });
    let cursorX = textX;
    page.drawText(label, { x: cursorX, y, size: 9.5, font: bold });
    cursorX += labelWidth + 3;
    const restLines = wrapText(rest.trim(), regular, 9.5, maxWidth - labelWidth - 3);
    page.drawText(restLines[0], { x: cursorX, y, size: 9.5, font: regular });
    y -= 12.5;
    for (let i = 1; i < restLines.length; i++) {
      newPageIfNeeded(12.5);
      page.drawText(restLines[i], { x: textX, y, size: 9.5, font: regular });
      y -= 12.5;
    }
  }

  y -= 10;
  newPageIfNeeded(14);
  const footer = 'github.com/sebastined  |  youtube.com/@nigeriantechbro  |  ikenga.ng  |  sebastine.com';
  const footerWidth = regular.widthOfTextAtSize(footer, 9);
  page.drawText(footer, { x: (PAGE_W - footerWidth) / 2, y, size: 9, font: regular, color: rgb(0.35, 0.35, 0.35) });

  const bytes = await pdfDoc.save();
  await writeFile(outPath, bytes);
}

// CLI entry point: node generate.mjs config.json out.pdf
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , configPath, outPath] = process.argv;
  if (!configPath || !outPath) {
    console.error('Usage: node generate.mjs <config.json> <outPath.pdf>');
    process.exit(1);
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await generate(config, outPath);
  console.log('wrote', outPath);
}
