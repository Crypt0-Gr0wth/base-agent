# Frontières de confiance de l’agent Base

Le dépôt assemble un agent conversationnel, plusieurs fournisseurs de données et Base Account. Cette composition crée quatre zones distinctes : l’interface utilisateur, le moteur de décision, les services externes et le portefeuille.

Une réponse de modèle n’est pas une autorisation de dépense. Une donnée reçue d’un outil n’est pas non plus une vérité sans contexte : elle doit rester associée à sa source, son horodatage et ses limites.

La frontière essentielle se situe entre la recommandation et la transaction. L’agent peut préparer une intention, tandis que Base Account conserve la signature et demande l’approbation explicite de l’utilisateur.

Cette séparation réduit l’impact d’une hallucination, d’un outil compromis ou d’une instruction malveillante. Elle ne remplace toutefois ni la validation des paramètres ni une politique de dépense restrictive.

[Chapitre suivant : provenance des données](02-provenance-des-donnees.md)
