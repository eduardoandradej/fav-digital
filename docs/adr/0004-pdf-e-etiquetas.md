# ADR 0004 — PDF gerado no servidor

**Status:** aceito

**Decisão:** o PDF da FAV e as etiquetas são gerados com `pdf-lib`, em A4 e fontes padrão. As fontes padrão não cobrem
todo o Unicode; caracteres fora do WinAnsi são substituídos por "?".
- A saída documental compõe Informações Gerais e Encaminhamentos, com continuação automática de páginas.
- Etiquetas saem 2 por página, com "Volume X de N".
- Todo documento registra versão da ficha, instante, responsável e SHA-256 (`document_export`), além da auditoria de segurança.

**Pendente:** fonte TTF embutida para Unicode completo e aprovação do layout pela área responsável.
