export const typstHighlights = `
(heading) @heading
(strong) @strong
(emph) @italic
(math) @math

(ident) @variable
(field field: (ident) @property)
(tagged field: (ident) @property)
(call item: (ident) @function)
(call item: (field field: (ident) @function))
(let pattern: (ident) @function value: (lambda))
(show value: (ident) @function)
(show value: (field field: (ident) @function))

(number) @number
[(bool) (auto) (none)] @keyword
(string) @string
[(raw_span) (raw_blck)] @raw
(raw_blck lang: (ident) @raw)
[(url) (label) (ref)] @link
(comment) @comment

[
  "let" "set" "show" "context"
  "import" "include" "as"
  "if" "else" "for" "in" "while"
  "return" "break" "continue"
] @keyword

["(" ")" "[" "]" "{" "}" ":" ";" "," "."] @punctuation
[
  "+" "-" "*" "/" "=" "==" "!=" "<" "<=" ">" ">="
  "and" "or" "not" "=>" ".." "^" "_" "!" "&" "assign"
] @operator
[(symbol) (shorthand) (escape) (linebreak) (align) (wildcard)] @operator
"$" @operator

"#" @keyword
(code "#" @function (call))
(heading ["=" "==" "===" "====" "=====" "======"] @heading)
(strong "*" @operator)
(emph "_" @operator)
(label ["<" ">"] @link)
`
