# De la recommandation à l’approbation

Le dépôt laisse les clés de signature dans Base Account et demande à l’agent de préparer une transaction. C’est une propriété de sécurité importante : l’application ne devrait jamais transformer une réponse textuelle en exécution silencieuse.

L’écran d’approbation doit présenter la chaîne, la cible, la valeur, le jeton, les autorisations et les effets attendus. Un résumé naturel ne suffit pas lorsque les calldata produisent un comportement différent.

La transaction doit être reconstruite ou revalidée juste avant signature. Prix, nonce, allowance et destination peuvent avoir changé depuis la recommandation initiale.

Le refus et l’expiration sont des états normaux, pas des erreurs à contourner. Toute nouvelle tentative doit repartir d’une intention visible et ne jamais réutiliser implicitement une ancienne approbation.

[Chapitre suivant : sessions et secrets](05-sessions-et-secrets.md)
