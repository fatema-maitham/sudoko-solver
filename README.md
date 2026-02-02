# 🧩 Sudoku Solver (Web App)

**Sudoku Solver** is a modern web-based Sudoku application built with **HTML, CSS, and JavaScript**.
It allows users to **enter puzzles manually**, **load puzzles from text files**, or **scan Sudoku images using OCR**, then visually solve them step-by-step using a powerful solving algorithm.

---

## 📘 Overview

This project combines **user-friendly design**, **algorithmic problem solving**, and **image processing** into a single interactive web app.

The solver validates puzzles in real time, highlights conflicts, and visually demonstrates the solving process using logical deduction and backtracking — making it both **educational** and **practical**.

---

## ✨ Why this project?

Because it demonstrates:
- Real algorithmic thinking (not brute force only)
- Clean UI + UX
- Advanced OCR preprocessing
- Step-by-step visualization of problem solving

It’s ideal as a **portfolio project**, **learning tool**, or **academic submission**.

---

## 🚀 Features

### 🧠 Sudoku Solving
- Automatic puzzle solving using constraint propagation + backtracking
- Step-by-step animation showing guesses and backtracking
- Conflict detection with real-time highlighting

### ✍️ Input Methods
- Manual entry using keyboard navigation
- Load from text file (81 digits, `0` for empty cells)
- OCR from image – crop a Sudoku photo and extract digits automatically

### 🎨 User Interface
- Clean 9×9 grid with bold 3×3 borders
- Active cell highlighting
- Given vs solved number styling
- Responsive layout (desktop & mobile)

---

## 🖼 OCR Capabilities

The OCR system is optimized for **light / blue Sudoku grids** and includes:
- Image cropping before recognition
- Grayscale + contrast enhancement
- Percentile thresholding
- Grid-line removal
- Per-cell OCR with multiple variants
- Confidence-based cleanup of incorrect digits

OCR runs fully in the browser using **Tesseract.js**.

---

## 🛠 Technical Stack

Frontend: HTML5, CSS3  
Logic: JavaScript (ES6)  
OCR Engine: Tesseract.js  
Algorithm: Constraint Propagation + DFS Backtracking (MRV)  
Rendering: HTML Canvas

---

## 🧠 Solving Techniques Used

- Candidate elimination
- Single-candidate placement
- Only-position placement (row / column / box)
- Backtracking with MRV (Minimum Remaining Values)

---

## 📁 Project Structure

/
├── index.html      # Main HTML entry point and layout
├── styles.css      # Application styling (layout, board, buttons, modal)
├── app.js          # UI logic, user interactions, and solver animation
├── solver.js       # Core Sudoku solving engine and algorithms
├── ocr.js          # Image OCR, preprocessing, and grid extraction
└── README.md       # Project documentation

---

## ▶️ How to Run

1. Download or clone the project
2. Open `index.html` in any modern browser
3. Enter a puzzle manually, load a text file, or upload an image
4. Click **Solve** to watch the algorithm work

No installation or server required.

---

## 🎯 Skills Demonstrated

- Algorithm design and reasoning
- JavaScript engineering
- Image preprocessing and OCR
- UI/UX design
- Debugging and validation
- Performance optimization

---

## ⚠️ OCR Accuracy Notes

OCR accuracy depends on image quality, lighting, and grid clarity.
Users can manually edit detected numbers before solving.

---

## Credits

Developer: **Fatema Maitham**

---

A complete Sudoku solving experience combining algorithms, UI design, and OCR — built to demonstrate strong front-end and problem-solving skills.
