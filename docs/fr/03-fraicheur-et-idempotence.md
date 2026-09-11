# Fraîcheur, cadence et idempotence

Les scanners périodiques observent un système qui change entre deux passages. Un solde, un prix ou une autorisation peut devenir obsolète avant même que la recommandation soit lue.

Chaque résultat devrait porter une durée de validité et être invalidé lorsqu’un nouvel état contredit ses hypothèses. À défaut, l’interface doit signaler clairement que l’information est historique.

La répétition d’un scan pose aussi un problème d’idempotence. Deux observations identiques ne devraient pas créer deux alertes indépendantes ni deux intentions de transaction concurrentes.

Une clé stable construite à partir du compte, de la chaîne, du risque et de l’état observé permet de dédupliquer. La résolution d’une alerte doit également être enregistrée pour éviter sa résurrection sans changement réel.

[Chapitre suivant : approbation des transactions](04-approbation-des-transactions.md)
